/**
 * Beckn v2.0 LTS schema validation (FN-087 / T-2.8.1.2).
 *
 * Validates inbound HTTP request bodies against the canonical Beckn protocol
 * schemas before the gateway routes them to on-chain instruction handlers.
 *
 * Strategy:
 *   - Inline Beckn v2.0 core JSON Schema definitions per action (no bundled
 *     file dependency at runtime; schema is versioned here)
 *   - Compile per-action validators with ajv (strict mode + allErrors)
 *   - Export a single `validateBecknRequest(action, body) → ValidationResult`
 *     API
 *   - Return per-error path + reason so the bridge can return 400 with a
 *     useful payload
 *
 * Canonical actions implemented (real schemas):
 *   search, select, init, confirm,
 *   on_search, on_select, on_init, on_confirm
 *
 * Stub actions (FN-087 deferred):
 *   status, cancel, rating, support,
 *   on_status, on_cancel, on_rating, on_support
 */

import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

// ---------- Action type ----------

export type BecknAction =
  | "search"
  | "select"
  | "init"
  | "confirm"
  | "status"
  | "cancel"
  | "rating"
  | "support"
  | "on_search"
  | "on_select"
  | "on_init"
  | "on_confirm"
  | "on_status"
  | "on_cancel"
  | "on_rating"
  | "on_support";

// ---------- Result type ----------

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: { path: string; reason: string }[] };

// ---------- Shared sub-schemas ----------

/**
 * Beckn v2.0 LTS context envelope. Required on every action.
 * Spec: https://github.com/beckn/protocol-specifications/tree/master/draft/Schemas
 */
export const becknContextSchema = {
  type: "object",
  required: [
    "domain",
    "action",
    "version",
    "bap_id",
    "bap_uri",
    "transaction_id",
    "message_id",
    "timestamp",
  ],
  properties: {
    domain: { type: "string", minLength: 1 },
    action: {
      type: "string",
      enum: [
        "search",
        "select",
        "init",
        "confirm",
        "status",
        "cancel",
        "rating",
        "support",
        "on_search",
        "on_select",
        "on_init",
        "on_confirm",
        "on_status",
        "on_cancel",
        "on_rating",
        "on_support",
      ],
    },
    version: { type: "string", const: "2.0.0" },
    bap_id: { type: "string", minLength: 1 },
    bap_uri: { type: "string", format: "uri" },
    bpp_id: { type: "string", minLength: 1 },
    bpp_uri: { type: "string", format: "uri" },
    transaction_id: { type: "string", format: "uuid" },
    message_id: { type: "string", format: "uuid" },
    timestamp: { type: "string", format: "date-time" },
    ttl: {
      type: "string",
      // Permissive on Y/M components; parseIso8601DurationMs in inbound-bap.ts
      // is the authoritative gate and rejects Y/M with BAD_TTL. See FN-188 / FN-074.
      pattern:
        "^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(?:\.\d+)?S)?)?$",
    },
    location: { type: "object" },
  },
  additionalProperties: true,
} as const;

// Descriptor sub-schema — common across multiple message types
const descriptorSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    code: { type: "string" },
    short_desc: { type: "string" },
    long_desc: { type: "string" },
    images: {
      type: "array",
      items: {
        type: "object",
        properties: {
          url: { type: "string", format: "uri" },
          size_type: { type: "string" },
        },
        additionalProperties: true,
      },
    },
  },
  additionalProperties: true,
} as const;

// Intent sub-schema — used by /search
const intentSchema = {
  type: "object",
  properties: {
    item: {
      type: "object",
      properties: {
        descriptor: descriptorSchema,
        category_ids: { type: "array", items: { type: "string" } },
      },
      additionalProperties: true,
    },
    provider: {
      type: "object",
      properties: {
        descriptor: descriptorSchema,
        categories: { type: "array", items: { type: "object", additionalProperties: true } },
        locations: { type: "array", items: { type: "object", additionalProperties: true } },
      },
      additionalProperties: true,
    },
    fulfillment: {
      type: "object",
      properties: {
        type: { type: "string" },
        stops: { type: "array", items: { type: "object", additionalProperties: true } },
      },
      additionalProperties: true,
    },
    payment: {
      type: "object",
      properties: {
        type: { type: "string" },
        collected_by: { type: "string" },
      },
      additionalProperties: true,
    },
    tags: { type: "array", items: { type: "object", additionalProperties: true } },
  },
  additionalProperties: true,
} as const;

// Item sub-schema — used in orders
const itemSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string", minLength: 1 },
    quantity: {
      type: "object",
      properties: {
        selected: {
          type: "object",
          properties: { count: { type: "integer", minimum: 1 } },
          additionalProperties: true,
        },
      },
      additionalProperties: true,
    },
    descriptor: descriptorSchema,
    price: {
      type: "object",
      properties: {
        currency: { type: "string" },
        value: { type: "string" },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
} as const;

// Provider sub-schema — used in orders
const orderProviderSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string", minLength: 1 },
    descriptor: descriptorSchema,
    locations: { type: "array", items: { type: "object", additionalProperties: true } },
  },
  additionalProperties: true,
} as const;

// Fulfillment sub-schema — used in init/confirm
const fulfillmentSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string" },
    customer: {
      type: "object",
      properties: {
        person: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
          additionalProperties: true,
        },
        contact: {
          type: "object",
          properties: {
            email: { type: "string", format: "email" },
            phone: { type: "string" },
          },
          additionalProperties: true,
        },
      },
      additionalProperties: true,
    },
    stops: { type: "array", items: { type: "object", additionalProperties: true } },
  },
  additionalProperties: true,
} as const;

// Billing sub-schema — used in init/confirm
const billingSchema = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1 },
    address: { type: "string" },
    email: { type: "string", format: "email" },
    phone: { type: "string" },
    tax_id: { type: "string" },
  },
  additionalProperties: true,
} as const;

// ---------- Per-action wrapper schemas ----------

// Full request envelope builder
function requestEnvelope(messageSchema: object): object {
  return {
    type: "object",
    required: ["context", "message"],
    properties: {
      context: becknContextSchema,
      message: messageSchema,
    },
    additionalProperties: true,
  };
}

// /search — BAP → BPP broadcast with search intent
const searchSchema = requestEnvelope({
  type: "object",
  required: ["intent"],
  properties: {
    intent: intentSchema,
  },
  additionalProperties: true,
});

// /select — BAP picks items from a catalog response
const selectSchema = requestEnvelope({
  type: "object",
  required: ["order"],
  properties: {
    order: {
      type: "object",
      required: ["provider", "items"],
      properties: {
        provider: orderProviderSchema,
        items: {
          type: "array",
          minItems: 1,
          items: itemSchema,
        },
        fulfillments: {
          type: "array",
          items: fulfillmentSchema,
        },
        payments: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
});

// /init — BAP provides billing + fulfillment details to lock escrow
const initSchema = requestEnvelope({
  type: "object",
  required: ["order"],
  properties: {
    order: {
      type: "object",
      required: ["provider", "items", "billing", "fulfillments"],
      properties: {
        provider: orderProviderSchema,
        items: {
          type: "array",
          minItems: 1,
          items: itemSchema,
        },
        billing: billingSchema,
        fulfillments: {
          type: "array",
          minItems: 1,
          items: fulfillmentSchema,
        },
        payments: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
});

// /confirm — BAP confirms the order; BPP signs acceptance
const confirmSchema = requestEnvelope({
  type: "object",
  required: ["order"],
  properties: {
    order: {
      type: "object",
      required: ["id", "state"],
      properties: {
        id: { type: "string", minLength: 1 },
        state: { type: "string", minLength: 1 },
        provider: orderProviderSchema,
        items: {
          type: "array",
          minItems: 1,
          items: itemSchema,
        },
        billing: billingSchema,
        fulfillments: {
          type: "array",
          items: fulfillmentSchema,
        },
        payments: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
});

// on_search — BPP callback: returns catalog
const onSearchSchema = requestEnvelope({
  type: "object",
  required: ["catalog"],
  properties: {
    catalog: {
      type: "object",
      required: ["providers"],
      properties: {
        descriptor: descriptorSchema,
        providers: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["id"],
            properties: {
              id: { type: "string", minLength: 1 },
              descriptor: descriptorSchema,
              categories: { type: "array", items: { type: "object", additionalProperties: true } },
              items: { type: "array", items: itemSchema },
              locations: { type: "array", items: { type: "object", additionalProperties: true } },
              fulfillments: { type: "array", items: { type: "object", additionalProperties: true } },
            },
            additionalProperties: true,
          },
        },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
});

// on_select — BPP callback: returns quoted order
const onSelectSchema = requestEnvelope({
  type: "object",
  required: ["order"],
  properties: {
    order: {
      type: "object",
      required: ["provider", "items"],
      properties: {
        provider: orderProviderSchema,
        items: {
          type: "array",
          minItems: 1,
          items: itemSchema,
        },
        fulfillments: {
          type: "array",
          items: fulfillmentSchema,
        },
        quote: {
          type: "object",
          properties: {
            price: {
              type: "object",
              properties: {
                currency: { type: "string" },
                value: { type: "string" },
              },
              additionalProperties: true,
            },
            breakup: { type: "array", items: { type: "object", additionalProperties: true } },
          },
          additionalProperties: true,
        },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
});

// on_init — BPP callback: returns initialised order with payment terms
const onInitSchema = requestEnvelope({
  type: "object",
  required: ["order"],
  properties: {
    order: {
      type: "object",
      required: ["provider", "items", "billing", "fulfillments"],
      properties: {
        provider: orderProviderSchema,
        items: {
          type: "array",
          minItems: 1,
          items: itemSchema,
        },
        billing: billingSchema,
        fulfillments: {
          type: "array",
          minItems: 1,
          items: fulfillmentSchema,
        },
        payments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string" },
              params: { type: "object", additionalProperties: true },
              status: { type: "string" },
            },
            additionalProperties: true,
          },
        },
        quote: {
          type: "object",
          properties: {
            price: {
              type: "object",
              properties: {
                currency: { type: "string" },
                value: { type: "string" },
              },
              additionalProperties: true,
            },
            breakup: { type: "array", items: { type: "object", additionalProperties: true } },
          },
          additionalProperties: true,
        },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
});

// on_confirm — BPP callback: returns confirmed order with final state
const onConfirmSchema = requestEnvelope({
  type: "object",
  required: ["order"],
  properties: {
    order: {
      type: "object",
      required: ["id", "state"],
      properties: {
        id: { type: "string", minLength: 1 },
        state: { type: "string", minLength: 1 },
        provider: orderProviderSchema,
        items: {
          type: "array",
          minItems: 1,
          items: itemSchema,
        },
        billing: billingSchema,
        fulfillments: {
          type: "array",
          items: fulfillmentSchema,
        },
        payments: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
});

// ---------- AJV setup ----------

const ajv = new Ajv({ strict: true, allErrors: true, allowUnionTypes: true });
addFormats(ajv);

// ---------- Schema registry ----------

const SCHEMAS: Partial<Record<BecknAction, object>> = {
  search: searchSchema,
  select: selectSchema,
  init: initSchema,
  confirm: confirmSchema,
  on_search: onSearchSchema,
  on_select: onSelectSchema,
  on_init: onInitSchema,
  on_confirm: onConfirmSchema,
  // Stub actions (FN-087 deferred — wired as unsupported below)
  // status, cancel, rating, support, on_status, on_cancel, on_rating, on_support
};

const COMPILED: Partial<Record<BecknAction, ValidateFunction>> = {};
for (const [action, schema] of Object.entries(SCHEMAS)) {
  COMPILED[action as BecknAction] = ajv.compile(schema);
}

// ---------- Public API ----------

/**
 * Validate an inbound Beckn HTTP request body against the v2.0 LTS schema
 * for the given action.
 *
 * Returns `{ ok: true }` on success, or `{ ok: false, errors }` with per-field
 * path and reason so the caller can construct a descriptive NACK response.
 */
export function validateBecknRequest(
  action: BecknAction,
  body: unknown,
): ValidationResult {
  const validator = COMPILED[action];
  if (!validator) {
    return {
      ok: false,
      errors: [{ path: "", reason: `action not yet wired (FN-087): ${action}` }],
    };
  }
  if (validator(body)) return { ok: true };
  const errors = (validator.errors ?? []).map((e: ErrorObject) => ({
    path: e.instancePath || "/",
    reason: `${e.keyword}: ${e.message ?? "(no message)"}`,
  }));
  return { ok: false, errors };
}
