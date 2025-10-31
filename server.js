const express = require('express');
const { Client, Environment } = require('square');
const crypto = require('crypto');

const app = express();

// --- FIX FOR DUPLICATE HEADERS ---
// This replaces app.use(express.json()) and forces JSON parsing manually
app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => (data += chunk));
  req.on('end', () => {
    try {
      req.body = data ? JSON.parse(data) : {};
    } catch {
      req.body = {};
    }
    next();
  });
});

// Initialize Square client
const squareClient = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment:
    process.env.SQUARE_ENVIRONMENT === 'production'
      ? Environment.Production
      : Environment.Sandbox,
});

const LOCATION_ID = process.env.SQUARE_LOCATION_ID;

// Root route
app.get('/', (req, res) => {
  res.send('✅ Square API server is running');
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date(),
    environment: process.env.SQUARE_ENVIRONMENT || 'sandbox',
  });
});

// --- CREATE ORDER ENDPOINT ---
app.post('/api/create-order', async (req, res) => {
  console.log('Incoming payload:', JSON.stringify(req.body, null, 2));

  try {
    let items_json, customer_name, customer_phone, customer_email, notes, toolCallId;

    // Handle both Vapi toolCalls and manual test payloads
    if (req.body.message && req.body.message.toolCalls) {
      const toolCall = req.body.message.toolCalls[0];
      toolCallId = toolCall.id;
      ({ items_json, customer_name, customer_phone, customer_email, notes } =
        toolCall.function.arguments);
    } else {
      ({ items_json, customer_name, customer_phone, customer_email, notes } = req.body);
      toolCallId = 'manual';
    }

    console.log('Parsed variables:', {
      items_json,
      customer_name,
      customer_phone,
      customer_email,
      notes,
    });

    // Parse the items JSON
    let items;
    try {
      items = JSON.parse(items_json);
    } catch (err) {
      throw new Error('Invalid items_json format');
    }

    // Build Square line items
    const lineItems = items.map(item => ({
      name: item.name,
      quantity: item.quantity.toString(),
      basePriceMoney: {
        amount: Math.round(parseFloat(item.price) * 100), // dollars → cents
        currency: 'USD',
      },
      note: item.customization || '',
    }));

    const { ordersApi } = squareClient;
    const orderResponse = await ordersApi.createOrder({
      order: {
        locationId: LOCATION_ID,
        lineItems,
        metadata: {
          customer_name: customer_name || '',
          customer_phone: customer_phone || '',
          source: 'vapi_test',
        },
      },
      idempotencyKey: crypto.randomUUID(),
    });

    const order = orderResponse.result.order;
    const totalAmount = order.totalMoney ? order.totalMoney.amount / 100 : 0;

    const message = `✅ Order created successfully! Order ID: ${order.id}. Total: $${totalAmount.toFixed(
      2
    )}`;

    res.json({
      results: [
        {
          toolCallId,
          result: JSON.stringify({
            success: true,
            order_id: order.id,
            total: totalAmount,
            message,
          }),
        },
      ],
    });
  } catch (error) {
    console.error('Order creation error:', error);

    res.status(500).json({
      results: [
        {
          toolCallId: 'error',
          result: JSON.stringify({
            success: false,
            message: `❌ Failed to create order: ${error.message}`,
          }),
        },
      ],
    });
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
