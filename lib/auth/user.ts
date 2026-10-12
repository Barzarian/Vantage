export class AuthenticationRequiredError extends Error {
  constructor() {
    super("Authentication is required.");
    this.name = "AuthenticationRequiredError";
  }
}

export async function requireCurrentUserId(): Promise<string> {
  if (process.env.NODE_ENV !== "production") return "local-user";

  throw new AuthenticationRequiredError();
}

export function authenticationErrorResponse(error: unknown): Response | null {
  return error instanceof AuthenticationRequiredError
    ? Response.json({ error: error.message }, { status: 401 })
    : null;
}
