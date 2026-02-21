// Simple in-memory store for rate limiting: IP -> lastRequestTimestamp
// NOTE: This is per server instance and will reset on redeploy/cold start.
const ipRequestStore = new Map();

// Rate limit window: 5 minutes (in milliseconds)
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    // x-forwarded-for can be a comma-separated list; take the first
    return xff.split(",")[0].trim();
  }
  // Fallback
  return req.socket?.remoteAddress || "unknown";
}

function isRateLimited(ip) {
  const now = Date.now();
  const lastTime = ipRequestStore.get(ip);

  if (!lastTime) {
    // No previous request registered → not limited
    ipRequestStore.set(ip, now);
    return false;
  }

  // If the last request was within the 5 minute window, limit this one
  if (now - lastTime < RATE_LIMIT_WINDOW_MS) {
    return true;
  }

  // Window passed → allow and update timestamp
  ipRequestStore.set(ip, now);
  return false;
}

export default async function handler(req, res) {
  try {
    // Only allow POST
    if (req.method !== "POST") {
      return res.status(405).json({
        success: false,
        error: "METHOD_NOT_ALLOWED",
        message: "Method not allowed",
      });
    }

    // Rate limit by IP: 1 request per 5 minutes
    const ip = getClientIp(req);
    if (isRateLimited(ip)) {
      return res.status(429).json({
        success: false,
        error: "RATE_LIMIT_EXCEEDED",
        message:
          "You can only place a COD order once every 5 minutes from this IP.",
      });
    }

    // App proxy sends ?shop, ?timestamp, ?signature, etc.
    const { shop, signature, ...params } = req.query;

    if (!shop || !signature) {
      return res.status(403).json({
        success: false,
        error: "INVALID_APP_PROXY",
        message: "Forbidden - Invalid app proxy request",
      });
    }

    if (!shop.endsWith(".myshopify.com")) {
      return res.status(403).json({
        success: false,
        error: "INVALID_SHOP_DOMAIN",
        message: "Forbidden - Invalid shop domain",
      });
    }

    // Parse body (may be JSON string)
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch (e) {
        return res.status(400).json({
          success: false,
          error: "BAD_REQUEST",
          message: "Invalid JSON in request body",
        });
      }
    }

    const { name, phone, address, city, variantId, quantity } = body || {};

    if (!name || !phone || !address || !variantId || !city || !quantity) {
      return res.status(400).json({
        success: false,
        error: "MISSING_FIELDS",
        message: "Missing required fields",
      });
    }

    const ENV_SHOP_NAME = process.env.SHOP_NAME; // e.g. "fxykrg-k1.myshopify.com"
    const ENV_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

    if (!ENV_SHOP_NAME || !ENV_ACCESS_TOKEN) {
      return res.status(500).json({
        success: false,
        error: "SERVER_MISCONFIGURED",
        message: "SHOP_NAME or SHOPIFY_ACCESS_TOKEN env vars are missing",
      });
    }

    // --------- GraphQL orderCreate mutation ---------
    const mutation = `
      mutation orderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
        orderCreate(order: $order, options: $options) {
          userErrors {
            field
            message
          }
          order {
            id
            displayFinancialStatus
            shippingAddress {
              name
              phone
              address1
              city
              provinceCode
              countryCode
              zip
            }
            billingAddress {
              name
              phone
              address1
              city
              provinceCode
              countryCode
              zip
            }
            customer {
              email
              firstName
              lastName
              phone
            }
          }
        }
      }
    `;

    const firstName = name; // full name into firstName (lastName omitted)
    const variantGid = `gid://shopify/ProductVariant/${variantId}`;
    const orderInput = {
      lineItems: [
        {
          variantId: variantGid, // GID string
          quantity: Number(quantity),
        },
      ],
      customer: {
        toUpsert: {
          firstName,
          phone,
        },
      },
      shippingAddress: {
        firstName,
        phone,
        address1: address,
        city,
      },
      billingAddress: {
        firstName,
        phone,
        address1: address,
        city,
      },
      note: "PendingDing😁",
      financialStatus: "PENDING",
    };

    const graphQLBody = {
      query: mutation,
      variables: {
        order: orderInput,
        options: null,
      },
    };

    const shopifyRes = await fetch(
      `https://${ENV_SHOP_NAME}/admin/api/2026-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": ENV_ACCESS_TOKEN,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(graphQLBody),
      },
    );

    const contentType = shopifyRes.headers.get("content-type");
    let data;

    if (contentType && contentType.includes("application/json")) {
      data = await shopifyRes.json();
      console.log("Shopify GraphQL response:", JSON.stringify(data, null, 2));
    } else {
      const text = await shopifyRes.text();
      console.error("Non-JSON response from Shopify:", text);
      return res.status(502).json({
        success: false,
        error: "SHOPIFY_INVALID_RESPONSE",
        message: "Invalid response from Shopify (non-JSON)",
        details: text,
      });
    }

    // 1) HTTP-level errors (rare for valid GraphQL)
    if (!shopifyRes.ok) {
      console.error("Shopify GraphQL HTTP error:", data);
      return res.status(shopifyRes.status || 400).json({
        success: false,
        error: "SHOPIFY_HTTP_ERROR",
        message: "Non-200 HTTP from Shopify GraphQL",
        details: data,
      });
    }

    // 2) Top-level GraphQL errors
    if (data.errors && data.errors.length > 0) {
      console.error("Shopify GraphQL errors:", data.errors);

      // Try to pull out the first error code if available
      const firstError = data.errors[0];
      const code = firstError?.extensions?.code || "GRAPHQL_ERROR";

      // Map some common Shopify GraphQL codes to HTTP statuses
      let status = 400;
      if (code === "THROTTLED" || code === "MAX_COST_EXCEEDED") {
        status = 429;
      } else if (code === "ACCESS_DENIED") {
        status = 403;
      } else if (code === "INTERNAL_SERVER_ERROR") {
        status = 502;
      }

      return res.status(status).json({
        success: false,
        error: code,
        message: firstError.message,
        details: data.errors,
      });
    }

    // 3) Mutation-level userErrors (business / validation errors)
    const orderCreateResult = data.data?.orderCreate;
    if (!orderCreateResult) {
      console.error("Missing orderCreate payload:", data);
      return res.status(502).json({
        success: false,
        error: "MISSING_ORDER_CREATE",
        message: "Invalid response from Shopify - no orderCreate field",
        details: data,
      });
    }

    const userErrors = orderCreateResult.userErrors || [];
    if (userErrors.length > 0) {
      console.error("Shopify orderCreate userErrors:", userErrors);

      // Example: you can inspect specific messages and map them if you want.
      // e.g. if phone duplicates, or invalid variant, etc.
      return res.status(400).json({
        success: false,
        error: "ORDER_CREATE_VALIDATION_ERROR",
        message: "Shopify rejected the order input",
        details: userErrors,
      });
    }

    // 4) Successful mutation: order present
    const order = orderCreateResult.order;
    if (!order) {
      console.error("No order object returned:", orderCreateResult);
      return res.status(502).json({
        success: false,
        error: "NO_ORDER_RETURNED",
        message: "No order returned from Shopify",
        details: orderCreateResult,
      });
    }

    // Final success response to your frontend
    return res.status(200).json({
      success: true,
      orderId: order.id,
      financialStatus: order.displayFinancialStatus,
      message: "Order placed successfully via GraphQL",
      order,
    });
  } catch (err) {
    console.error("Server crash:", err);

    return res.status(500).json({
      success: false,
      error: "INTERNAL_SERVER_ERROR",
      message: err.message,
    });
  }
}
