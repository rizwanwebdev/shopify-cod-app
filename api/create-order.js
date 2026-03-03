export default async function handler(req, res) {
  // Entry log for every request
  console.log("=== /api/create-order HIT ===", {
    method: req.method,
    query: req.query,
    time: new Date().toISOString(),
  });

  try {
    // ─────────────────────────────────────────
    // 1. Basic request validation
    // ─────────────────────────────────────────
    if (req.method !== "POST") {
      console.warn("METHOD_NOT_ALLOWED", { method: req.method });
      return res.status(405).json({
        success: false,
        error: "METHOD_NOT_ALLOWED",
      });
    }

    const ENV_SHOP_NAME = process.env.SHOP_NAME;
    const ENV_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

    console.log("Env check", {
      ENV_SHOP_NAME: !!ENV_SHOP_NAME,
      HAS_ACCESS_TOKEN: !!ENV_ACCESS_TOKEN,
    });

    const { shop, signature } = req.query;

    console.log("Incoming request params", {
      shop,
      signaturePresent: !!signature,
    });

    if (!shop || !signature || !shop.endsWith(".myshopify.com")) {
      console.warn("INVALID_PROXY_REQUEST", {
        shop,
        signaturePresent: !!signature,
      });
      return res.status(403).json({
        success: false,
        error: "INVALID_PROXY_REQUEST",
      });
    }

    if (shop !== ENV_SHOP_NAME) {
      console.warn("SHOP_MISMATCH", { shop, ENV_SHOP_NAME });
      return res.status(403).json({
        success: false,
        error: "SHOP_MISMATCH",
      });
    }

    if (!ENV_SHOP_NAME || !ENV_ACCESS_TOKEN) {
      console.error("SERVER_MISCONFIGURED", {
        ENV_SHOP_NAME,
        HAS_ACCESS_TOKEN: !!ENV_ACCESS_TOKEN,
      });
      return res.status(500).json({
        success: false,
        error: "SERVER_MISCONFIGURED",
      });
    }

    // ─────────────────────────────────────────
    // 2. Parse and validate body
    // ─────────────────────────────────────────
    let body = req.body;
    if (typeof body === "string") {
      console.log("Parsing JSON body from string");
      body = JSON.parse(body);
    }

    console.log("Request body raw", body);

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
      console.warn("MISSING_FIELDS", {
        hasName: !!name,
        hasPhone: !!phone,
        hasAddress: !!address,
        hasCity: !!city,
        hasVariantId: !!variantId,
        hasQuantity: !!quantity,
      });
      return res.status(400).json({
        success: false,
        error: "MISSING_FIELDS",
      });
    }

    const firstName = name;
    const lastName = "-";
    const variantGid = `gid://shopify/ProductVariant/${variantId}`;
    const normalizedPhone = String(phone).replace(/\D/g, "");

    console.log("Normalized data", {
      firstName,
      lastName,
      variantGid,
      phone,
      normalizedPhone,
      quantity,
    });

    // ─────────────────────────────────────────
    // 3. CUSTOMER LOOKUP BY PHONE
    // ─────────────────────────────────────────
    const findCustomerByPhoneQuery = `
      query FindCustomerByPhone($query: String!) {
        customers(first: 1, query: $query) {
          edges {
            node {
              id
              defaultPhoneNumber {
                phoneNumber
              }
              defaultEmailAddress {
                emailAddress
              }
            }
          }
        }
      }
    `;

    const customerSearchQuery = `phone:"${normalizedPhone}"`;

    console.log("Customer lookup GraphQL request", {
      customerSearchQuery,
      endpoint: `https://${ENV_SHOP_NAME}/admin/api/2026-01/graphql.json`,
    });

    const customerLookupRes = await fetch(
      `https://${ENV_SHOP_NAME}/admin/api/2026-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": ENV_ACCESS_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: findCustomerByPhoneQuery,
          variables: { query: customerSearchQuery },
        }),
      },
    );

    console.log("Customer lookup response status", customerLookupRes.status);

    const customerLookupData = await customerLookupRes.json();
    console.log(
      "Customer lookup data:",
      JSON.stringify(customerLookupData, null, 2),
    );

    if (customerLookupData.errors) {
      console.error(
        "Customer lookup GraphQL errors",
        customerLookupData.errors,
      );
    }

    const customerEdges = customerLookupData?.data?.customers?.edges || [];
    const existingCustomer =
      customerEdges.length > 0 ? customerEdges[0].node : null;

    console.log("Customer lookup result", {
      found: !!existingCustomer,
      customerId: existingCustomer?.id || null,
    });

    // ─────────────────────────────────────────
    // 4. DUPLICATE CHECK (10-minute window, by customer)
    // ─────────────────────────────────────────
    if (existingCustomer) {
      const TEN_MINUTES = 10 * 60 * 1000;
      const tenMinutesAgoDate = new Date(Date.now() - TEN_MINUTES);

      console.log("Duplicate check window", {
        tenMinutesAgo: tenMinutesAgoDate.toISOString(),
        now: new Date().toISOString(),
      });

      // Use customer_id:... in orders search
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

      const orderSearchQuery = `customer_id:${existingCustomer.id}`;

      console.log("Duplicate orders GraphQL request", {
        orderSearchQuery,
        endpoint: `https://${ENV_SHOP_NAME}/admin/api/2026-01/graphql.json`,
      });

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
            variables: { query: orderSearchQuery },
          }),
        },
      );

      console.log("Duplicate response status", duplicateRes.status);

      const duplicateData = await duplicateRes.json();
      console.log(
        "Duplicate data from Shopify (by customer):",
        JSON.stringify(duplicateData, null, 2),
      );

      if (duplicateData.errors) {
        console.error("Duplicate query GraphQL errors", duplicateData.errors);
      }

      const existingOrders = duplicateData?.data?.orders?.edges || [];
      console.log(
        "Duplicate check - existingOrders length (by customer)",
        existingOrders.length,
      );

      for (const edge of existingOrders) {
        const order = edge.node;
        const createdAtDate = new Date(order.createdAt);

        const hasSameVariant = order.lineItems.edges.some(
          (item) => item.node.variant?.id === variantGid,
        );
        const isWithin10Min = createdAtDate >= tenMinutesAgoDate;

        console.log("Checking existing order for duplicate", {
          orderId: order.id,
          createdAt: order.createdAt,
          hasSameVariant,
          isWithin10Min,
        });

        if (hasSameVariant && isWithin10Min) {
          console.log("Duplicate order detected. Returning early.", {
            orderId: order.id,
          });
          return res.status(200).json({
            success: true,
            duplicate: true,
            message: "Order already placed recently.",
            orderId: order.id,
          });
        }
      }

      console.log(
        "No duplicate order found for this customer + variant within 10 minutes",
      );
    } else {
      console.log(
        "No existing customer found for phone; skipping duplicate check by customer.",
      );
    }

    // ─────────────────────────────────────────
    // 5. ORDER CREATION (no duplicate found)
    // ─────────────────────────────────────────
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
      customer: existingCustomer
        ? {
            // Existing customer: associate by ID
            toAssociate: {
              id: existingCustomer.id,
            },
          }
        : {
            // New customer: create with name + phone only
            toUpsert: {
              firstName,
              lastName,
              phone: normalizedPhone,
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
      shippingLines: [
        {
          title: "Free Shipping",
          code: "Free Shipping",
          source: "Custom",
          priceSet: {
            shopMoney: {
              amount: 0.0,
              currencyCode: "PKR",
            },
          },
        },
      ],
      tags: ["Pending", "SPEED-COD"],
      financialStatus: "PENDING",
    };

    if (Number(quantity) === 2 && dis_percent && discount_code) {
      console.log("Applying discount code", {
        quantity,
        dis_percent,
        discount_code,
      });
      orderInput.discountCode = {
        itemPercentageDiscountCode: {
          percentage: Number(dis_percent),
          code: String(discount_code),
        },
      };
    }

    console.log(
      "Final orderInput to Shopify:",
      JSON.stringify(orderInput, null, 2),
    );

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

    console.log("orderCreate response status", shopifyRes.status);

    const data = await shopifyRes.json();
    console.log(
      "Shopify orderCreate response data:",
      JSON.stringify(data, null, 2),
    );

    if (data.errors) {
      console.error("Top-level GraphQL errors", data.errors);
      return res.status(400).json({
        success: false,
        error: "GRAPHQL_ERROR",
        details: data.errors,
      });
    }

    const result = data.data?.orderCreate;

    if (!result || result.userErrors?.length) {
      console.warn("ORDER_CREATE_FAILED", {
        userErrors: result?.userErrors,
      });
      return res.status(400).json({
        success: false,
        error: "ORDER_CREATE_FAILED",
        details: result?.userErrors,
      });
    }

    console.log("Order created successfully", {
      orderId: result.order.id,
      displayFinancialStatus: result.order.displayFinancialStatus,
    });

    return res.status(200).json({
      success: true,
      duplicate: false,
      orderId: result.order.id,
      financialStatus: result.order.displayFinancialStatus,
      message: "Order placed successfully.",
    });
  } catch (err) {
    console.error("Handler error (catch)", err);
    return res.status(500).json({
      success: false,
      error: "INTERNAL_SERVER_ERROR",
      message: err.message,
    });
  }
}
