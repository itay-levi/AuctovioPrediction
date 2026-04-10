import { LoginErrorType } from "@shopify/shopify-app-remix/server";
import { describe, expect, it } from "vitest";
import { loginErrorMessage } from "./error.server";

describe("loginErrorMessage", () => {
  it("returns shop message for missing shop", () => {
    expect(loginErrorMessage({ shop: LoginErrorType.MissingShop })).toEqual({
      shop: "Please enter your shop domain to log in",
    });
  });

  it("returns shop message for invalid shop", () => {
    expect(loginErrorMessage({ shop: LoginErrorType.InvalidShop })).toEqual({
      shop: "Please enter a valid shop domain to log in",
    });
  });

  it("returns empty object otherwise", () => {
    expect(loginErrorMessage({ shop: undefined } as never)).toEqual({});
  });
});
