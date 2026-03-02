export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({
        success: false,
        error: "METHOD_NOT_ALLOWED",
      });
    }

    const ENV_SHOP_NAME = process.env.SHOP_NAME;
    const ENV_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

    const { shop, signature } = req.query;

    if (!shop || !signature || !shop.endsWith(".myshopify.com")) {
      return res.status(403).json({
        success: false,
        error: "INVALID_PROXY_REQUEST",
      });
    }

    if (shop !== ENV_SHOP_NAME) {
      return res.status(403).json({
        success: false,
        error: "SHOP_MISMATCH",
      });
    }

    if (!ENV_SHOP_NAME || !ENV_ACCESS_TOKEN) {
      return res.status(500).json({
        success: false,
        error: "SERVER_MISCONFIGURED",
      });
    }

    // Parse body
    let body = req.body;
    if (typeof body === "string") {
      body = JSON.parse(body);
    }

    const {
      name,
      phone,
      address,
      city,
      variantId,
      quantity,
      dis_percent,
      discount_code,
    } = body || {};

    if (!name || !phone || !address || !city || !variantId || !quantity) {
      return res.status(400).json({
        success: false,
        error: "MISSING_FIELDS",
      });
    }

    const firstName = name;
    const lastName = "-";
    const variantGid = `gid://shopify/ProductVariant/${variantId}`;
    const normalizedPhone = String(phone).replace(/\D/g, "");

    // ======================================================
    // 🔎 DUPLICATE CHECK (10 minute window)
    // ======================================================

    const TEN_MINUTES = 10 * 60 * 1000;
    const tenMinutesAgo = new Date(Date.now() - TEN_MINUTES).toISOString();

    const duplicateQuery = `
      query CheckDuplicateOrder($query: String!) {
        orders(first: 5, query: $query, sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              id
              createdAt
              lineItems(first: 10) {
                edges {
                  node {
                    variant {
                      id
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;
    const syntheticEmail = `cod-${normalizedPhone}@test.com`;

    const searchQuery = `
        email:"${syntheticEmail}" 
        created_at:>=${tenMinutesAgo}
      `;

    const duplicateRes = await fetch(
      `https://${ENV_SHOP_NAME}/admin/api/2026-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": ENV_ACCESS_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: duplicateQuery,
          variables: { query: searchQuery },
        }),
      },
    );

    const duplicateData = await duplicateRes.json();
    const existingOrders = duplicateData?.data?.orders?.edges || [];

    for (const edge of existingOrders) {
      const order = edge.node;

      const hasSameVariant = order.lineItems.edges.some(
        (item) => item.node.variant?.id === variantGid,
      );

      if (hasSameVariant) {
        return res.status(200).json({
          success: true,
          duplicate: true,
          message: "Order already placed recently.",
          orderId: order.id,
        });
      }
    }

    // ======================================================
    // 🛒 CREATE ORDER (No duplicate found)
    // ======================================================

    const mutation = `
      mutation orderCreate($order: OrderCreateOrderInput!) {
        orderCreate(order: $order) {
          userErrors {
            field
            message
          }
          order {
            id
            displayFinancialStatus
          }
        }
      }
    `;

    const orderInput = {
      lineItems: [
        {
          variantId: variantGid,
          quantity: Number(quantity),
          requiresShipping: true,
        },
      ],
      customer: {
        toUpsert: {
          email: syntheticEmail,
          firstName,
          lastName,
          phone,
        },
      },
      shippingAddress: {
        firstName,
        lastName,
        phone,
        address1: address,
        city,
        countryCode: "PK",
      },
      billingAddress: {
        firstName,
        lastName,
        phone,
        address1: address,
        city,
        countryCode: "PK",
      },
      // ✅ Add this block:
      shippingLines: [
        {
          title: "Free Shipping",
          code: "Free Shipping", // optional reference string
          source: "Custom", // any identifier for your app/channel
          priceSet: {
            shopMoney: {
              amount: 0.0, // number, not string
              currencyCode: "PKR", // your shop currency code
            },
          },
          // taxLines: []                // optional if you have shipping taxes
        },
      ],
      tags: ["Pending", "SPEED-COD"],
      financialStatus: "PENDING",
    };

    if (Number(quantity) === 2 && dis_percent && discount_code) {
      orderInput.discountCode = {
        itemPercentageDiscountCode: {
          percentage: Number(dis_percent),
          code: String(discount_code),
        },
      };
    }

    const shopifyRes = await fetch(
      `https://${ENV_SHOP_NAME}/admin/api/2026-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": ENV_ACCESS_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: mutation,
          variables: { order: orderInput },
        }),
      },
    );

    const data = await shopifyRes.json();
    console.log("Shopify response data:", JSON.stringify(data, null, 2));

    if (data.errors) {
      console.log(phone);
      return res.status(400).json({
        success: false,
        error: "GRAPHQL_ERROR",
        details: data.errors,
      });
    }

    const result = data.data?.orderCreate;

    if (!result || result.userErrors?.length) {
      return res.status(400).json({
        success: false,
        error: "ORDER_CREATE_FAILED",
        details: result?.userErrors,
      });
    }

    return res.status(200).json({
      success: true,
      duplicate: false,
      orderId: result.order.id,
      financialStatus: result.order.displayFinancialStatus,
      message: "Order placed successfully.",
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: "INTERNAL_SERVER_ERROR",
      message: err.message,
    });
  }
}
