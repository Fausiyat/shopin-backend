// shopin-backend/services/notificationService.js
const axios = require('axios');

/**
 * Sends transactional SMS alerts via Termii API
 * @param {string} to - Recipient phone number (e.g. "08012345678" or "2348012345678")
 * @param {string} message - Message body text
 */
const sendSMS = async (to, message) => {
  const apiKey = process.env.TERMII_API_KEY;
  const senderId = process.env.TERMII_SENDER_ID || 'N-Alert';

  if (!apiKey) {
    console.warn("⚠️ Termii API key missing in backend .env!");
    return { status: 'failed', reason: 'Missing API key' };
  }

  // Format Nigerian phone numbers to standard 234 format
  let formattedPhone = to.trim();
  if (formattedPhone.startsWith('0')) {
    formattedPhone = '234' + formattedPhone.slice(1);
  }

  const payload = {
    to: formattedPhone,
    from: senderId,
    sms: message,
    type: 'plain',
    channel: 'generic', // Use 'generic' for standard notifications or 'dnd' for OTPs
    api_key: apiKey
  };

  try {
    const response = await axios.post('https://api.ng.termii.com/api/sms/send', payload);
    console.log(`✅ SMS dispatched to ${formattedPhone}:`, response.data);
    return response.data;
  } catch (error) {
    console.error(`❌ Termii SMS Error (${formattedPhone}):`, error.response?.data || error.message);
    throw error;
  }
};

module.exports = { sendSMS };