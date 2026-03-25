const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

async function askAI(prompt) {
  console.log("AI prompt:", prompt);
  return "Hello! This is a demo response from AI.";
}


// Wrapper to match expected interface in USSD route
async function generateAIAssistantMessage(merchantId, topic) {
  // You can customize the prompt based on topic
  let prompt = "";
  if (topic === "summary") {
    prompt = `Give a weekly business summary for merchant ID: ${merchantId}`;
  } else if (topic === "promo") {
    prompt = `Suggest a promotional SMS for merchant ID: ${merchantId}`;
  } else if (topic === "inventory") {
    prompt = `Give inventory advice for merchant ID: ${merchantId}`;
  } else {
    prompt = `Give a business tip for merchant ID: ${merchantId}`;
  }
  return askAI(prompt);
}

module.exports = { askAI };
module.exports.generateAIAssistantMessage = generateAIAssistantMessage;
