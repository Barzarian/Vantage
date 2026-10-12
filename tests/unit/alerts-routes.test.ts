import { afterEach, describe, expect, it } from "vitest";
import { PATCH } from "@/app/api/alerts/[alertId]/route";
import { deleteAlert, saveAlert } from "@/lib/alerts/service";

describe("alert update route", () => {
  let alertId: string | undefined;

  afterEach(async () => {
    if (alertId) await deleteAlert("local-user", alertId);
    alertId = undefined;
  });

  it("treats full edits containing active as edits, not a pause toggle", async () => {
    const created = await saveAlert("local-user", {
      name: "Original name",
      symbol: "AAPL",
      assetClass: "equity",
      condition: { type: "price", comparison: "above", threshold: 100 },
    });
    alertId = created.id;

    const response = await PATCH(new Request("http://localhost/api/alerts/test", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Updated name",
        symbol: "AAPL",
        assetClass: "equity",
        condition: { type: "price", comparison: "above", threshold: 110 },
        triggerMode: "every-cross",
        cooldownSeconds: 300,
        active: false,
        onlyRegularHours: false,
        maxJumpPercent: 20,
      }),
    }), { params: Promise.resolve({ alertId: created.id }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: created.id,
      name: "Updated name",
      active: false,
      condition: { type: "price", threshold: 110 },
    });
  });
});
