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
        error: "Method not allowed",
      });
    }

    // Rate limit by IP: 1 request per 5 minutes
    const ip = getClientIp(req);
    if (isRateLimited(ip)) {
      return res.status(429).json({
        success: false,
        error: "Rate limit exceeded",
        details:
          "You can only place a COD order once every 5 minutes from this IP.",
      });
    }

    // App proxy sends ?shop, ?timestamp, ?signature, etc.
    const { shop, signature, ...params } = req.query;

    if (!shop || !signature) {
      return res.status(403).json({
        success: false,
        error: "Forbidden - Invalid app proxy request",
      });
    }

    if (!shop.endsWith(".myshopify.com")) {
      return res.status(403).json({
        success: false,
        error: "Forbidden - Invalid shop domain",
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
          error: "Invalid JSON in request body",
        });
      }
    }

    const { name, phone, address, variantId, quantity } = body || {};

    if (!name || !phone || !address || !variantId || !quantity) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields",
      });
    }
    const ENV_SHOP_NAME = process.env.SHOP_NAME;
    const ENV_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

    // Call Shopify Admin REST API to create the order
    const shopifyRes = await fetch(
      `https://${ENV_SHOP_NAME}/admin/api/2024-01/orders.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": ENV_ACCESS_TOKEN,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          order: {
            line_items: [
              {
                variant_id: Number(variantId),
                quantity: Number(quantity),
              },
            ],
            customer: {
              first_name: name,
              phone: phone,
            },
            billing_address: {
              address1: address,
              phone: phone,
            },
            shipping_address: {
              address1: address,
              phone: phone,
            },
            financial_status: "pending",
            gateway: "Cash on Delivery",
          },
        }),
      },
    );

    const contentType = shopifyRes.headers.get("content-type");
    let data;

    if (contentType && contentType.includes("application/json")) {
      data = await shopifyRes.json();
    } else {
      const text = await shopifyRes.text();
      console.error("Non-JSON response from Shopify:", text);
      return res.status(502).json({
        success: false,
        error: "Invalid response from Shopify",
        details: "Received non-JSON response",
      });
    }

    if (!shopifyRes.ok) {
      console.error("Shopify API error:", data);

      // Handle "customer.phone_number has already been taken"
      if (
        data &&
        data.errors &&
        data.errors["customer.phone_number"] &&
        Array.isArray(data.errors["customer.phone_number"]) &&
        data.errors["customer.phone_number"].includes("has already been taken")
      ) {
        return res.status(409).json({
          success: false,
          error: "Customer phone already exists",
          code: "CUSTOMER_PHONE_TAKEN",
          details: data.errors,
        });
      }

      // Default error
      return res.status(400).json({
        success: false,
        error: "Shopify API error",
        details: data.errors || data,
      });
    }

    return res.status(200).json({
      success: true,
      orderId: data.order?.id,
      message: "Order placed successfully",
    });
  } catch (err) {
    console.error("Server crash:", err);

    return res.status(500).json({
      success: false,
      error: "Internal server error",
      message: err.message,
    });
  }
}
