const express = require('express');
const { Client, Environment } = require('square');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// Initialize Square client
const squareClient = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: process.env.SQUARE_ENVIRONMENT === 'production' 
    ? Environment.Production 
    : Environment.Sandbox
});

const LOCATION_ID = process.env.SQUARE_LOCATION_ID;

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date(),
    environment: process.env.SQUARE_ENVIRONMENT || 'sandbox'
  });
});

// Create Order endpoint
app.post('/api/create-order', async (req, res) => {
  try {
    const { message } = req.body;
    const toolCall = message.toolCalls[0];
    const { items, customer_name, customer_phone, customer_email, notes } = toolCall.function.arguments;

    // Build line items for Square
    const lineItems = items.map(item => ({
      name: item.name,
      quantity: item.quantity.toString(),
      basePriceMoney: {
        amount: Math.round(item.price * 100), // Convert to cents
        currency: 'USD'
      },
      note: item.customization || ''
    }));

    // Create the order
    const orderResponse = await squareClient.ordersApi.createOrder({
      order: {
        locationId: LOCATION_ID,
        lineItems: lineItems,
        state: 'OPEN',
        metadata: {
          customer_name: customer_name || '',
          customer_phone: customer_phone || '',
          source: 'vapi_phone_assistant'
        }
      },
      idempotencyKey: crypto.randomUUID()
    });

    const order = orderResponse.result.order;
    const totalAmount = order.totalMoney.amount / 100;

    // Format response for Vapi
    const itemsList = items.map(i => `${i.quantity}x ${i.name}`).join(', ');
    
    res.json({
      results: [{
        toolCallId: toolCall.id,
        result: JSON.stringify({
          success: true,
          order_id: order.id,
          total: totalAmount,
          message: `Order created successfully! Order ID: ${order.id}. Items: ${itemsList}. Total: $${totalAmount.toFixed(2)}`
        })
      }]
    });

  } catch (error) {
    console.error('Order creation error:', error);
    res.json({
      results: [{
        toolCallId: req.body.message.toolCalls[0].id,
        result: JSON.stringify({
          success: false,
          message: `Failed to create order: ${error.message}`
        })
      }]
    });
  }
});

// Process Payment endpoint
app.post('/api/process-payment', async (req, res) => {
  try {
    const { message } = req.body;
    const toolCall = message.toolCalls[0];
    const { order_id, payment_method, source_id } = toolCall.function.arguments;

    // Get the order first to get the total
    const orderResponse = await squareClient.ordersApi.retrieveOrder(order_id);
    const order = orderResponse.result.order;

    // Create payment
    const paymentResponse = await squareClient.paymentsApi.createPayment({
      sourceId: source_id || 'CASH', // For phone orders, you might use CASH or card-on-file
      orderId: order_id,
      amountMoney: order.totalMoney,
      locationId: LOCATION_ID,
      idempotencyKey: crypto.randomUUID()
    });

    const payment = paymentResponse.result.payment;

    res.json({
      results: [{
        toolCallId: toolCall.id,
        result: JSON.stringify({
          success: true,
          payment_id: payment.id,
          amount: payment.amountMoney.amount / 100,
          message: `Payment processed successfully! Payment ID: ${payment.id}. Amount: $${(payment.amountMoney.amount / 100).toFixed(2)}`
        })
      }]
    });

  } catch (error) {
    console.error('Payment processing error:', error);
    res.json({
      results: [{
        toolCallId: req.body.message.toolCalls[0].id,
        result: JSON.stringify({
          success: false,
          message: `Payment failed: ${error.message}`
        })
      }]
    });
  }
});

// Get Menu Items endpoint
app.post('/api/get-menu', async (req, res) => {
  try {
    const { message } = req.body;
    const toolCall = message.toolCalls[0];
    const { category } = toolCall.function.arguments;

    // Retrieve catalog items
    const catalogResponse = await squareClient.catalogApi.listCatalog(
      undefined, // cursor
      category ? `category_id:${category}` : 'type:ITEM'
    );

    const items = catalogResponse.result.objects || [];
    
    // Format menu items for the assistant
    const menuItems = items
      .filter(obj => obj.type === 'ITEM')
      .map(item => {
        const variation = item.itemData.variations?.[0];
        const price = variation?.itemVariationData?.priceMoney?.amount 
          ? variation.itemVariationData.priceMoney.amount / 100 
          : 0;
        
        return {
          name: item.itemData.name,
          price: price,
          description: item.itemData.description || '',
          id: item.id
        };
      });

    const menuText = menuItems
      .map(item => `${item.name} - $${item.price.toFixed(2)}${item.description ? ': ' + item.description : ''}`)
      .join(', ');

    res.json({
      results: [{
        toolCallId: toolCall.id,
        result: JSON.stringify({
          success: true,
          items: menuItems,
          message: `Available items: ${menuText || 'No items found'}`
        })
      }]
    });

  } catch (error) {
    console.error('Menu retrieval error:', error);
    res.json({
      results: [{
        toolCallId: req.body.message.toolCalls[0].id,
        result: JSON.stringify({
          success: false,
          message: `Failed to retrieve menu: ${error.message}`
        })
      }]
    });
  }
});

// Create or Get Customer endpoint
app.post('/api/manage-customer', async (req, res) => {
  try {
    const { message } = req.body;
    const toolCall = message.toolCalls[0];
    const { phone_number, email, name } = toolCall.function.arguments;

    // Search for existing customer
    let customer;
    if (phone_number || email) {
      const searchResponse = await squareClient.customersApi.searchCustomers({
        query: {
          filter: {
            phoneNumber: phone_number ? { exact: phone_number } : undefined,
            emailAddress: email ? { exact: email } : undefined
          }
        }
      });

      customer = searchResponse.result.customers?.[0];
    }

    // Create customer if not found
    if (!customer) {
      const createResponse = await squareClient.customersApi.createCustomer({
        givenName: name,
        phoneNumber: phone_number,
        emailAddress: email,
        idempotencyKey: crypto.randomUUID()
      });
      customer = createResponse.result.customer;
    }

    res.json({
      results: [{
        toolCallId: toolCall.id,
        result: JSON.stringify({
          success: true,
          customer_id: customer.id,
          customer_name: customer.givenName || 'Customer',
          message: `Customer ${customer.givenName || 'profile'} located. Customer ID: ${customer.id}`
        })
      }]
    });

  } catch (error) {
    console.error('Customer management error:', error);
    res.json({
      results: [{
        toolCallId: req.body.message.toolCalls[0].id,
        result: JSON.stringify({
          success: false,
          message: `Customer lookup failed: ${error.message}`
        })
      }]
    });
  }
});

// Calculate Order Total endpoint
app.post('/api/calculate-total', async (req, res) => {
  try {
    const { message } = req.body;
    const toolCall = message.toolCalls[0];
    const { items, tax_rate, tip_percentage } = toolCall.function.arguments;

    let subtotal = 0;
    items.forEach(item => {
      subtotal += item.price * item.quantity;
    });

    const tax = tax_rate ? subtotal * (tax_rate / 100) : 0;
    const tip = tip_percentage ? subtotal * (tip_percentage / 100) : 0;
    const total = subtotal + tax + tip;

    const itemsList = items.map(i => `${i.quantity}x ${i.name} ($${(i.price * i.quantity).toFixed(2)})`).join(', ');

    res.json({
      results: [{
        toolCallId: toolCall.id,
        result: JSON.stringify({
          success: true,
          subtotal: subtotal.toFixed(2),
          tax: tax.toFixed(2),
          tip: tip.toFixed(2),
          total: total.toFixed(2),
          message: `Order breakdown: ${itemsList}. Subtotal: $${subtotal.toFixed(2)}, Tax: $${tax.toFixed(2)}, Tip: $${tip.toFixed(2)}. Total: $${total.toFixed(2)}`
        })
      }]
    });

  } catch (error) {
    console.error('Total calculation error:', error);
    res.json({
      results: [{
        toolCallId: req.body.message.toolCalls[0].id,
        result: JSON.stringify({
          success: false,
          message: `Failed to calculate total: ${error.message}`
        })
      }]
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Vapi Square Backend running on port ${PORT}`);
  console.log(`Environment: ${process.env.SQUARE_ENVIRONMENT || 'sandbox'}`);
});
