const express = require('express');
const { Client, Environment } = require('square');
const crypto = require('crypto');

const app = express();
app.use(express.json());

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

// Create Order endpoint
app.post('/api/create-order', async (req, res) => {
  console.log('Incoming payload:', JSON.stringify(req.body, null, 2));
  try {
    let items_json, customer_name, customer_phone, customer_email, notes, toolCallId;

    // Support both Vapi structure and test requests
    if (req.body.message && req.body.message.toolCalls) {
      const toolCall = req.body.message.toolCalls[0];
      toolCallId = toolCall.id;
      ({ items_json, customer_name, customer_phone, customer_email, notes } = toolCall.function.arguments);
    } else {
      ({ items_json, customer_name, customer_phone, customer_email, notes } = req.body);
      toolCallId = 'manual';
    }

    console.log('Parsed variables:', { items_json, customer_name, customer_phone, customer_email, notes });

    // Parse item JSON
    let items;
    try {
      items = JSON.parse(items_json);
    } catch (err) {
      throw new Error('Invalid items_json format');
    }

    // Build order line items
    const lineItems = items.map(item => ({
      name: item.name,
      quantity: item.quantity.toString(),
      basePriceMoney: {
        amount: Math.round(parseFloat(item.price) * 100),
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

    const resultMessage = `✅ Order created successfully! Order ID: ${order.id}. Total: $${totalAmount.toFixed(2)}`;

    res.json({
      results: [
        {
          toolCallId,
          result: JSON.stringify({
            success: true,
            order_id: order.id,
            total: totalAmount,
            message: resultMessage,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
