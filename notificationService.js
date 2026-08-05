// services/notificationService.js
const axios = require('axios');

const TERMII_BASE_URL = 'https://api.ng.termii.com/api';
const API_KEY = process.env.TERMII_API_KEY;
const SENDER_ID = process.env.TERMII_SENDER_ID || 'ShopIn';

// Helper to format Nigerian phone numbers (e.g. 08012345678 -> 2348012345678)
const formatPhoneNumber = (phone) => {
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '234' + cleaned.slice(1);
  }
  return cleaned;
};

// 1. Send SMS Alert
const sendSMS = async (to, message) => {
  try {
    const payload = {
      to: formatPhoneNumber(to),
      from: SENDER_ID,
      sms: message,
      type: 'plain',
      channel: 'generic',
      api_key: API_KEY,
    };

    const response = await axios.post(`${TERMII_BASE_URL}/sms/send`, payload);
    console.log(`[SMS Sent] To: ${to} | Msg: ${message.slice(0, 30)}...`);
    return response.data;
  } catch (error) {
    console.error('[SMS Error]', error.response?.data || error.message);
    return null;
  }
};

// 2. Send WhatsApp Notification
const sendWhatsApp = async (to, message) => {
  try {
    const payload = {
      to: formatPhoneNumber(to),
      from: SENDER_ID,
      type: 'plain',
      channel: 'whatsapp',
      media: {
        url: '', // Optional image URL
        caption: ''
      },
      message: message,
      api_key: API_KEY,
    };

    const response = await axios.post(`${TERMII_BASE_URL}/sms/number/send`, payload);
    console.log(`[WhatsApp Sent] To: ${to}`);
    return response.data;
  } catch (error) {
    console.warn('[WhatsApp Fallback to SMS]', error.message);
    // Fall back to regular SMS if WhatsApp fails
    return await sendSMS(to, message);
  }
};

// 3. Application Workflow Notification Triggers
const notifications = {
  // Trigger A: Gift Order Dispatched
  sendGiftAlert: async ({ recipientPhone, recipientName, senderName, deliveryAddress }) => {
    const msg = `Hello ${recipientName}! 🎁 ${senderName} has sent you a gift package via ShopIn! Delivery Address: ${deliveryAddress}. Our driver will contact you shortly.`;
    return await sendSMS(recipientPhone, msg);
  },

  // Trigger B: Pay Small-Small Target Reached
  sendTargetAchievedAlert: async ({ userPhone, orderCode, targetTotal }) => {
    const msg = `🎉 Congratulations! Your ShopIn Target Goal of ₦${targetTotal.toLocaleString()} for Order ${orderCode} has been 100% completed! Sourcing has begun at Mandate Market.`;
    return await sendSMS(userPhone, msg);
  },

  // Trigger C: Market Shopper Sourcing Alert
  sendShopperAssignmentAlert: async ({ shopperPhone, orderCode, itemCount, hubLocation }) => {
    const msg = `📋 MANDATE HUB ALERT: New batch order ${orderCode} (${itemCount} items) assigned to you for picking at ${hubLocation}. Open Shopper Console.`;
    return await sendSMS(shopperPhone, msg);
  }
};

module.exports = notifications;
