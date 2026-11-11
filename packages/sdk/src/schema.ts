import Ajv, { ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

function createAjvInstance(): Ajv {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    validateFormats: true,
  });
  addFormats(ajv);
  return ajv;
}

export const sharedSchemaAjv = createAjvInstance();

export function compileJsonSchema(schema: unknown): ValidateFunction {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("expectedJsonSchema must be a JSON Schema object");
  }
  return sharedSchemaAjv.compile(schema as Record<string, any>);
}

export function validateJsonSchemaDefinition(schema: unknown): {
  valid: boolean;
  error?: string;
} {
  try {
    compileJsonSchema(schema);
    return { valid: true };
  } catch (err: any) {
    return {
      valid: false,
      error: err?.message || "Invalid JSON Schema definition",
    };
  }
}
