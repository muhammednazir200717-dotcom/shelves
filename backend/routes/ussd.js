const express = require("express");
const router = express.Router();
const db = require("../services/database");
const smsService = require("../services/smsService");
const { normalizePhoneNumber } = require("../utils/phone");
const Product = require("../models/Product");
const Merchant = require("../models/Merchant");
const aiService = require("../services/gemini");

// In-memory customer session store (ephemeral).
const customerSessions = new Map();

// Helper to clean sessions
const purgeExpiredSessions = () => {
  const now = Date.now();
  for (const [k, v] of customerSessions.entries()) {
    if (v.expiresAt && v.expiresAt <= now) customerSessions.delete(k);
  }
};

router.post("/", async (req, res) => {
  // Africa's Talking requires EXACT format: Plain text only.
  res.set("Content-Type", "text/plain");

  // ─── CRITICAL DEBUG LOGS ──────────────────────────────────────────
  // If these don't show up in terminal, Africa's Talking is not reaching the server.
  console.log("\n>>> [USSD] INCOMING REQUEST at " + new Date().toISOString());
  console.log(">>> [USSD] BODY:", JSON.stringify(req.body));
  console.log(">>> [USSD] HEADER HOST:", req.headers.host);

  try {
    const { sessionId, serviceCode, phoneNumber: rawPhone, text = "" } = req.body;

    if (!sessionId) {
      console.log(">>> [USSD] ERROR: Missing sessionId");
      return res.send("END Error: Invalid session.");
    }

    const input = text === "" ? [] : text.split("*");
    console.log(">>> [USSD] SESSION:", sessionId, "INPUT:", input);

    // ─── Phone Validation ─────────────────────────────────────────
    const phoneNumber = normalizePhoneNumber(rawPhone);
    if (!phoneNumber) {
      console.log(">>> [USSD] ERROR: No phone number in request");
      return res.send("END System connection error. Please try again.");
    }

    // ─── Sanitization Helpers ─────────────────────────────────────
    const cleanText = (str) => {
      if (!str) return "";
      return str
        .normalize("NFKD")
        .replace(/[^\x20-\x7E\n]/g, "") // Printable ASCII + newlines
        .trim();
    };

    const formatMenu = (menu) => {
      return menu
        .replace(/\r/g, "")
        .split("\n")
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .join("\n");
    };

    const sendMenu = (content) => {
      const formatted = formatMenu(cleanText(content));
      console.log("USSD RESPONSE (first 80):", formatted.substring(0, 80));
      return res.send(formatted);
    };

    // ─── Identity Check ───────────────────────────────────────────
    const merchant = await db.getUser(phoneNumber);
    const merchantName = merchant ? cleanText(merchant.businessName) : "";

    // ─── Root Menu ────────────────────────────────────────────────
    if (input.length === 0) {
      purgeExpiredSessions();
      return sendMenu(`CON Welcome to SHELVES
1. Merchant
2. Customer`);
    }

    // ==========================================
    // MERCHANT FLOW (Option 1)
    // ==========================================
    if (input[0] === "1") {
      // If merchant not registered, guide through registration
      if (!merchant) {
        if (input.length === 1) return sendMenu("CON Welcome! Enter Business Name to register:");
        if (input.length === 2) return sendMenu(`CON Business: ${input[1]}\nNow enter Business Type:\n(e.g. Retail, Food, Services)`);
        if (input.length === 3) {
          try {
            await db.registerUser(phoneNumber, {
              businessName: input[1],
              businessType: input[2]
            });
            return sendMenu("END Registration successful! Please redial to access your dashboard.");
          } catch (regErr) {
            console.error("Merchant Reg Error:", regErr);
            return sendMenu("END Registration failed. Please try again later.");
          }
        }
        return sendMenu("END Invalid registration path.");
      }

      // Merchant exists, handle main dashboard
      const merchantSteps = input.slice(1);

      const mainMenu = () => `CON Welcome ${merchantName}
1. Inventory
2. View Stock
3. Record Sale
4. Today's Report
5. Send Promo SMS
6. Weekly Report
7. AI Assistant
8. Customer Orders
0. Exit`;

      if (merchantSteps.length === 0) return sendMenu(mainMenu());

      const option = merchantSteps[0];

      // Option 1: Inventory Management
      if (option === "1") {
        if (merchantSteps.length === 1) return sendMenu(`CON Inventory
1. Add Product
2. Update/Delete
3. SMS List
0. Back`);

        const action = merchantSteps[1];
        if (action === "0") return sendMenu(mainMenu());

        // Add Product
        if (action === "1") {
          if (merchantSteps.length === 2) return sendMenu("CON Enter Product Name:");
          if (merchantSteps.length === 3) return sendMenu("CON Selling Price:");
          if (merchantSteps.length === 4) return sendMenu("CON Cost Price:");
          if (merchantSteps.length === 5) return sendMenu("CON Initial Stock:");
          if (merchantSteps.length === 6) {
            const sellingPrice = parseFloat(merchantSteps[3]);
            const costPrice = parseFloat(merchantSteps[4]);
            const stock = parseInt(merchantSteps[5]);

            if (isNaN(sellingPrice) || isNaN(costPrice) || isNaN(stock)) return sendMenu("END Invalid numbers provided.");

            const productCode = await db.generateProductCode(merchant._id);
            await db.addProduct(merchant._id, {
              productCode,
              name: merchantSteps[2],
              sellingPrice,
              costPrice,
              stock
            });
            return sendMenu(`END Product Added!\nCode: ${productCode}`);
          }
          return sendMenu("END Invalid product step.");
        }

        // Update/Delete
        if (action === "2") {
          if (merchantSteps.length === 2) return sendMenu("CON Enter Product Code:");
          if (merchantSteps.length === 3) {
            const product = await db.getProductByCode(merchant._id, merchantSteps[2]);
            if (!product) return sendMenu("END Product not found.");
            return sendMenu(`CON ${cleanText(product.name)}
1. New Selling Price
2. New Cost Price
3. New Stock Qty
4. Delete Product
0. Back`);
          }
          if (merchantSteps.length === 4) {
            if (merchantSteps[3] === "4") {
              await db.deleteProductByCode(merchant._id, merchantSteps[2]);
              return sendMenu("END Product deleted.");
            }
            if (merchantSteps[3] === "0") return sendMenu(mainMenu());
            return sendMenu("CON Enter new value:");
          }
          if (merchantSteps.length === 5) {
            const code = merchantSteps[2];
            const field = merchantSteps[3];
            const val = parseFloat(merchantSteps[4]);
            if (isNaN(val)) return sendMenu("END Invalid value.");

            if (field === "1") await db.updateProductByCode(merchant._id, code, { sellingPrice: val });
            if (field === "2") await db.updateProductByCode(merchant._id, code, { costPrice: val });
            if (field === "3") await db.updateProductByCode(merchant._id, code, { stock: val });

            return sendMenu("END Product updated!");
          }
          return sendMenu("END Invalid update step.");
        }

        // SMS List
        if (action === "3") {
          const products = await db.getProducts(merchant._id);
          if (products.length === 0) return sendMenu("END Your inventory is empty.");
          let list = "Inventory:\n";
          products.slice(0, 5).forEach(p => list += `${p.productCode}: ${p.name} (${p.stock})\n`);
          return sendMenu(`END ${list}Full list sent via SMS.`);
        }

        return sendMenu("END Invalid inventory option.");
      }

      // Option 2: View Stock
      if (option === "2") {
        const products = await db.getProducts(merchant._id);
        if (products.length === 0) return sendMenu("END No stock records found.");
        let list = "Stock Status:\n";
        products.slice(0, 5).forEach(p => list += `${p.name}: ${p.stock}\n`);
        return sendMenu(`END ${list}`);
      }

      // Option 3: Record Sale
      if (option === "3") {
        if (merchantSteps.length === 1) return sendMenu("CON Enter Product Code:\n(0. Back)");
        if (merchantSteps.length === 2) {
          if (merchantSteps[1] === "0") return sendMenu(mainMenu());
          const product = await db.getProductByCode(merchant._id, merchantSteps[1]);
          if (!product) return sendMenu("END Product not found.");
          return sendMenu(`CON ${cleanText(product.name)}\nEnter quantity sold:`);
        }
        if (merchantSteps.length === 3) {
          const qty = parseInt(merchantSteps[2]);
          if (isNaN(qty) || qty <= 0) return sendMenu("END Invalid quantity.");
          try {
            const result = await db.recordSaleByCode(merchant._id, merchantSteps[1], qty);
            return sendMenu(`END Sale Recorded!\nRevenue: N${result.totalRevenue}\nProfit: N${result.totalProfit}`);
          } catch (err) {
            return sendMenu(`END Error: ${err.message}`);
          }
        }
        return sendMenu("END Invalid sale step.");
      }

      // Option 4: Today's Report
      if (option === "4") {
        const report = await db.getWeeklyProfit(merchant._id);
        return sendMenu(`END Today's Summary\nItems Sold: ${report.totalItems}\nRevenue: N${report.totalRevenue}\nProfit: N${report.totalProfit}`);
      }

      // Option 5: Send Promo SMS
      if (option === "5") {
        if (merchantSteps.length === 1) return sendMenu("CON Enter Promo Message:\n(0. Back)");
        if (merchantSteps.length === 2) {
          if (merchantSteps[1] === "0") return sendMenu(mainMenu());
          const Contact = require("../models/Contact");
          const contacts = await Contact.find({ merchantId: merchant._id });
          if (contacts.length === 0) return sendMenu("END You have no customer contacts.");
          const phoneNumbers = contacts.map(c => c.phone);
          await smsService.sendSMS(phoneNumbers, merchantSteps[1]);
          return sendMenu(`END Promo sent to ${phoneNumbers.length} customers.`);
        }
        return sendMenu("END Invalid promo step.");
      }

      // Option 6: Weekly Report
      if (option === "6") {
        const report = await db.getWeeklyProfit(merchant._id);
        const msg = `Weekly Report\nItems: ${report.totalItems}\nRevenue: N${report.totalRevenue}\nProfit: N${report.totalProfit}`;
        await smsService.sendSMS(phoneNumber, msg);
        return sendMenu("END Weekly report has been sent to your phone via SMS.");
      }

      // Option 7: AI Assistant (Async Safety & Timeout)
      if (option === "7") {
        if (merchantSteps.length === 1) return sendMenu(`CON AI Assistant
1. Weekly Summary
2. Promo Suggestion
3. Inventory Advice
0. Back`);

        if (merchantSteps.length === 2) {
          if (merchantSteps[1] === "0") return sendMenu(mainMenu());
          const topics = { "1": "summary", "2": "promo", "3": "inventory" };
          const topic = topics[merchantSteps[1]] || "summary";

          // Timeout race to prevent USSD hang
          const aiResponse = await Promise.race([
            aiService.generateAIAssistantMessage(merchant._id, topic),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 8000))
          ]).catch(err => {
            console.error("AI Error or Timeout:", err.message);
            return "AI is taking too long. We will send the advice via SMS shortly.";
          });

          return sendMenu(`END AI Assistant:\n${aiResponse}`);
        }
        return sendMenu("END Invalid AI option.");
      }

      // Option 8: Customer Orders
      if (option === "8") {
        const orders = await db.getMerchantOrders(merchant._id);
        if (orders.length === 0) return sendMenu("END No active customer orders.");
        let list = "Recent Orders:\n";
        orders.slice(0, 3).forEach((o, i) => list += `${i + 1}. ${o.productName} (Qty: ${o.quantity}) from ${o.customerPhone}\n`);
        return sendMenu(`END ${list}`);
      }

      // Exit
      if (option === "0") return sendMenu("END Thank you for using SHELVES.");

      return sendMenu("END Invalid merchant option.");
    }

    // ==========================================
    // CUSTOMER FLOW (Option 2)
    // ==========================================
    if (input[0] === "2") {
      const customerSteps = input.slice(1);
      const sessionKey = phoneNumber;
      let session = customerSessions.get(sessionKey);

      // Step 2*0 → Main menu
      if (customerSteps.length === 0) {
        return sendMenu(`CON Customer Menu
1. Shop by Store Code
2. Find Product
0. Back`);
      }

      const choice = customerSteps[0];

      // Back to root
      if (choice === "0") return sendMenu("CON Welcome to SHELVES\n1. Merchant\n2. Customer");

      // ── Choice 1: Shop by Store Code ────────────────────────────
      if (choice === "1") {
        // input.length === 2 → "2*1"  → prompt for store code
        if (customerSteps.length === 1) return sendMenu("CON Enter Store Code:\n(e.g. UMA47)");

        // input.length === 3 → "2*1*<code>" → find merchant
        if (customerSteps.length === 2) {
          const code = customerSteps[1].toUpperCase().trim();
          const targetMerchant = await Merchant.findOne({
            $or: [{ storeCode: code }, { merchantCode: code }]
          });
          if (!targetMerchant) return sendMenu("END Store code not found.");

          // Save session
          session = {
            merchantId: targetMerchant._id,
            merchantName: targetMerchant.businessName,
            expiresAt: Date.now() + 5 * 60 * 1000
          };
          customerSessions.set(sessionKey, session);

          return sendMenu(`CON ${cleanText(targetMerchant.businessName)}
1. View Products
2. Search in Store
0. Back`);
        }

        // input.length === 4 → "2*1*<code>*<subAction>" → handle store sub-options
        if (customerSteps.length === 3) {
          if (!session) return sendMenu("END Session expired. Please redial.");
          const subAction = customerSteps[2];

          // ── View Products list ──────────────────────────────────
          if (subAction === "1") {
            const products = await db.getProducts(session.merchantId);
            if (products.length === 0) return sendMenu("END Store has no products.");
            let list = `CON ${cleanText(session.merchantName)} Products:\n`;
            products.slice(0, 5).forEach((p, i) => list += `${i + 1}. ${cleanText(p.name)} - N${p.sellingPrice}\n`);
            list += "0. Back";
            return sendMenu(list);
          }

          // ── Search in Store ──────────────────────────────────────
          if (subAction === "2") {
            return sendMenu("CON Enter product name keyword:");
          }

          if (subAction === "0") {
            return sendMenu(`CON Customer Menu
1. Shop by Store Code
2. Find Product
0. Back`);
          }

          return sendMenu("END Invalid store option.");
        }

        // input.length === 5 → "2*1*<code>*<subAction>*<value>"
        if (customerSteps.length === 4) {
          if (!session) return sendMenu("END Session expired. Please redial.");
          const subAction = customerSteps[2];

          // ── Product selected from View Products list ─────────────
          if (subAction === "1") {
            const pIdx = parseInt(customerSteps[3]) - 1;
            if (customerSteps[3] === "0") {
              return sendMenu(`CON ${cleanText(session.merchantName)}
1. View Products
2. Search in Store
0. Back`);
            }
            const prods = await db.getProducts(session.merchantId);
            const selected = prods[pIdx];
            if (!selected) return sendMenu("END Invalid product selection.");
            return sendMenu(`CON ${cleanText(selected.name)}
Price: N${selected.sellingPrice}
1. Order Now
0. Back`);
          }

          // ── Search in Store: keyword entered ─────────────────────
          if (subAction === "2") {
            const keyword = customerSteps[3].toLowerCase();
            const products = await Product.find({
              merchant: session.merchantId,
              name: new RegExp(keyword, "i")
            });
            if (products.length === 0) return sendMenu("END No matching products found.");
            let list = "CON Results:\n";
            products.slice(0, 5).forEach((p, i) => list += `${i + 1}. ${cleanText(p.name)} - N${p.sellingPrice}\n`);
            list += "0. Back";
            return sendMenu(list);
          }

          return sendMenu("END Invalid option.");
        }

        // input.length === 6 → "2*1*<code>*1*<pIdx>*<action>" → Order Now or Back
        if (customerSteps.length === 5) {
          if (!session) return sendMenu("END Session expired. Please redial.");
          const subAction = customerSteps[2];

          if (subAction === "1") {
            const pIdx = parseInt(customerSteps[3]) - 1;
            const action = customerSteps[4];

            if (action === "0") {
              // Back to product list
              const products = await db.getProducts(session.merchantId);
              if (products.length === 0) return sendMenu("END Store has no products.");
              let list = `CON ${cleanText(session.merchantName)} Products:\n`;
              products.slice(0, 5).forEach((p, i) => list += `${i + 1}. ${cleanText(p.name)} - N${p.sellingPrice}\n`);
              list += "0. Back";
              return sendMenu(list);
            }

            if (action === "1") {
              // Prompt for quantity
              return sendMenu("CON Enter Quantity:");
            }

            return sendMenu("END Invalid order option.");
          }

          return sendMenu("END Invalid step.");
        }

        // input.length === 7 → "2*1*<code>*1*<pIdx>*1*<qty>" → Place order
        if (customerSteps.length === 6) {
          if (!session) return sendMenu("END Session expired. Please redial.");
          const subAction = customerSteps[2];

          if (subAction === "1") {
            const pIdx = parseInt(customerSteps[3]) - 1;
            const qty = parseInt(customerSteps[5]);

            if (isNaN(qty) || qty <= 0) return sendMenu("END Invalid quantity. Please redial.");

            const prods = await db.getProducts(session.merchantId);
            const selected = prods[pIdx];
            if (!selected) return sendMenu("END Product no longer available.");

            const merchantDoc = await Merchant.findById(session.merchantId);
            const total = selected.sellingPrice * qty;
            await db.createOrder({
              merchantId: session.merchantId,
              merchantPhone: merchantDoc ? merchantDoc.phone : "",
              customerPhone: phoneNumber,
              productCode: selected.productCode,
              productName: selected.name,
              quantity: qty
            });

            // customerSessions.delete(sessionKey); // MOVED TO FINAL PAYMENT STEP
            return sendMenu(`CON Order placed!
Store: ${cleanText(merchantDoc?.businessName)}
Phone: ${merchantDoc?.phone || "N/A"}
1. Proceed to Payment
2. Exit`);
          }

          return sendMenu("END Invalid order step.");
        }

        // input.length === 8 → "2*1*<code>*1*<pIdx>*1*<qty>*<paymentAction>"
        if (customerSteps.length === 7) {
          if (!session) return sendMenu("END Session expired. Please redial.");
          const paymentAction = customerSteps[6];

          if (paymentAction === "1") {
            const pIdx = parseInt(customerSteps[3]) - 1;
            const qty = parseInt(customerSteps[5]);
            const prods = await db.getProducts(session.merchantId);
            const selected = prods[pIdx];
            const total = selected ? selected.sellingPrice * qty : 0;
            const merchantDoc = await Merchant.findById(session.merchantId);

            customerSessions.delete(sessionKey);
            return sendMenu(`END Payment Details:
Bank: ${merchantDoc?.bankName || "N/A"}
Acct: ${merchantDoc?.accountNumber || "N/A"}
Total: N${total}
Merchant will contact you.`);
          }

          customerSessions.delete(sessionKey);
          return sendMenu("END Thank you for shopping with SHELVES.");
        }

        // Fallback for any unexpected depth
        return sendMenu("END Invalid shop option. Please redial.");
      }

      // ── Choice 2: Global Find Product (full 5-step order flow) ─
      if (choice === "2") {

        // STEP 1 — customerSteps.length === 1 → "2*2"
        // Prompt for keyword
        if (customerSteps.length === 1) {
          return sendMenu("CON Enter product name to search:");
        }

        // All deeper steps carry the keyword in customerSteps[1].
        // Re-fetch results each step so we never lose context.
        const keyword = customerSteps[1];

        // STEP 2 — customerSteps.length === 2 → "2*2*<keyword>"
        // Run search and show merchant list with product name + price
        if (customerSteps.length === 2) {
          if (keyword === "0") {
            return sendMenu(`CON Customer Menu
1. Shop by Store Code
2. Find Product
0. Back`);
          }

          console.log("[SEARCH] keyword:", keyword);
          const results = await Product.find({
            name: { $regex: keyword, $options: "i" },
            stock: { $gt: 0 }
          }).populate("merchant").limit(5);

          console.log("[SEARCH] results count:", results.length);

          if (results.length === 0) return sendMenu("END No products found for that search. Please redial.");

          let list = "CON Select a merchant:\n";
          results.forEach((r, i) => {
            const mName = cleanText(r.merchant ? r.merchant.businessName : "Unknown Store");
            const pName = cleanText(r.name);
            list += `${i + 1}. ${mName} - ${pName} - N${r.sellingPrice}\n`;
          });
          list += "0. Back";
          return sendMenu(list);
        }

        // STEP 3 — customerSteps.length === 3 → "2*2*<keyword>*<merchantIdx>"
        // User selected a merchant — ask for quantity
        if (customerSteps.length === 3) {
          const sel = customerSteps[2];
          if (sel === "0") return sendMenu("CON Enter product name to search:");

          const idx = parseInt(sel) - 1;
          if (isNaN(idx) || idx < 0) return sendMenu("END Invalid selection. Please redial.");

          // Re-fetch to confirm product still exists
          const results = await Product.find({
            name: { $regex: keyword, $options: "i" },
            stock: { $gt: 0 }
          }).populate("merchant").limit(5);

          const selected = results[idx];
          if (!selected) return sendMenu("END Invalid merchant selection. Please redial.");

          const mName = cleanText(selected.merchant ? selected.merchant.businessName : "Unknown Store");
          const pName = cleanText(selected.name);
          console.log("[ORDER] Selected:", pName, "from", mName, "@ N" + selected.sellingPrice);

          return sendMenu(`CON ${mName}: ${pName} @ N${selected.sellingPrice}\nEnter quantity:`);
        }

        // STEP 4 — customerSteps.length === 4 → "2*2*<keyword>*<merchantIdx>*<qty>"
        // User entered quantity — show confirmation screen
        if (customerSteps.length === 4) {
          const idx = parseInt(customerSteps[2]) - 1;
          const qty = parseInt(customerSteps[3]);

          if (isNaN(idx) || idx < 0) return sendMenu("END Invalid selection. Please redial.");
          if (isNaN(qty) || qty <= 0) return sendMenu("END Invalid quantity. Please enter a number greater than 0.");

          const results = await Product.find({
            name: { $regex: keyword, $options: "i" },
            stock: { $gt: 0 }
          }).populate("merchant").limit(5);

          const selected = results[idx];
          if (!selected) return sendMenu("END Product no longer available. Please redial.");

          const mName = cleanText(selected.merchant ? selected.merchant.businessName : "Unknown Store");
          const pName = cleanText(selected.name);
          const total = selected.sellingPrice * qty;

          return sendMenu(`CON Confirm Order:
Merchant: ${mName}
Product: ${pName}
Price: N${selected.sellingPrice}
Quantity: ${qty}
Total: N${total}
1. Confirm
2. Cancel`);
        }

        // STEP 5 — customerSteps.length === 5 → "2*2*<keyword>*<merchantIdx>*<qty>*<confirm>"
        // User confirmed or cancelled
        if (customerSteps.length === 5) {
          const confirm = customerSteps[4];

          if (confirm === "2") return sendMenu("END Order cancelled. Redial to start again.");

          if (confirm === "1") {
            const idx = parseInt(customerSteps[2]) - 1;
            const qty = parseInt(customerSteps[3]);

            if (isNaN(idx) || idx < 0) return sendMenu("END Invalid selection. Please redial.");
            if (isNaN(qty) || qty <= 0) return sendMenu("END Invalid quantity. Please redial.");

            const results = await Product.find({
              name: { $regex: keyword, $options: "i" },
              stock: { $gt: 0 }
            }).populate("merchant").limit(5);

            const selected = results[idx];
            if (!selected) return sendMenu("END Product no longer available. Please redial.");

            const merchantDoc = selected.merchant;
            const mName = cleanText(merchantDoc ? merchantDoc.businessName : "Unknown Store");
            const pName = cleanText(selected.name);
            const total = selected.sellingPrice * qty;

            // Place the order
            await db.createOrder({
              merchantId: merchantDoc._id || merchantDoc,
              merchantPhone: merchantDoc ? (merchantDoc.phone || "") : "",
              customerPhone: phoneNumber,
              productCode: selected.productCode || "",
              productName: selected.name,
              quantity: qty
            });

            // Notify merchant via SMS
            if (merchantDoc && merchantDoc.phone) {
              const smsMsg =
                `New USSD Order!\n` +
                `Customer: ${phoneNumber}\n` +
                `Product: ${pName}\n` +
                `Qty: ${qty}\n` +
                `Total: N${total}\n` +
                `Please contact customer to arrange delivery/payment.`;
              try {
                await smsService.sendSMS(merchantDoc.phone, smsMsg);
                console.log("[ORDER SMS] Sent to merchant:", merchantDoc.phone);
              } catch (smsErr) {
                console.error("[ORDER SMS] Failed to notify merchant:", smsErr.message);
                // Don't fail the order just because SMS failed
              }
            }

            console.log("[ORDER] Placed:", pName, "x", qty, "for", phoneNumber, "from", mName);
            return sendMenu(`CON Order placed!
Store: ${mName}
Phone: ${merchantDoc?.phone || "N/A"}
1. Proceed to Payment
2. Exit`);
          }

          return sendMenu("END Invalid option. Reply 1 to confirm or 2 to cancel.");
        }

        // STEP 6 — customerSteps.length === 6 → "2*2*<keyword>*<merchantIdx>*<qty>*1*<paymentAction>"
        if (customerSteps.length === 6) {
          const paymentAction = customerSteps[5];

          if (paymentAction === "1") {
            const idx = parseInt(customerSteps[2]) - 1;
            const qty = parseInt(customerSteps[3]);
            const results = await Product.find({
              name: { $regex: keyword, $options: "i" },
              stock: { $gt: 0 }
            }).populate("merchant").limit(5);

            const selected = results[idx];
            const merchantDoc = selected?.merchant;
            const total = selected ? selected.sellingPrice * qty : 0;

            return sendMenu(`END Payment Details:
Bank: ${merchantDoc?.bankName || "N/A"}
Acct: ${merchantDoc?.accountNumber || "N/A"}
Total: N${total}
Merchant will contact you.`);
          }

          return sendMenu("END Thank you for shopping with SHELVES.");
        }

        // Fallback
        return sendMenu("END Search session ended. Please redial.");
      }

      // Unknown customer choice
      return sendMenu("END Invalid customer option. Please redial.");
    }

    // Unknown root option
    return sendMenu("END Thank you for using SHELVES.");

  } catch (error) {
    console.error("USSD CRITICAL ERROR:", error);
    return res.send("END System temporarily unavailable. Please try again later.");
  }
});

module.exports = router;
