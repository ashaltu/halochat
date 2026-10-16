import { describe, expect, it } from "vitest";
import { ApprovalThreshold, ContactRequestState } from "./enums.js";
import { evaluateContactRequestState, evaluateSideApproval } from "./state-machine.js";

const vote = (side: "REQUESTER" | "RECIPIENT", status: "PENDING" | "APPROVED" | "DECLINED") => ({
  angelUserId: crypto.randomUUID(),
  side,
  status,
});

describe("contact request approvals", () => {
  it("accepts one approval under ANY_ONE despite another decline", () => {
    const result = evaluateSideApproval(ApprovalThreshold.ANY_ONE, [
      vote("RECIPIENT", "APPROVED"),
      vote("RECIPIENT", "DECLINED"),
    ]);
    expect(result.isApproved).toBe(true);
  });

  it("makes ALL impossible after one decline", () => {
    const result = evaluateSideApproval(ApprovalThreshold.ALL, [
      vote("REQUESTER", "APPROVED"),
      vote("REQUESTER", "DECLINED"),
    ]);
    expect(result.isDeclined).toBe(true);
  });

  it("requires both protected sides to approve", () => {
    expect(evaluateContactRequestState({
      recipientThreshold: ApprovalThreshold.ANY_ONE,
      recipientVotes: [vote("RECIPIENT", "APPROVED")],
      requesterThreshold: ApprovalThreshold.ALL,
      requesterVotes: [vote("REQUESTER", "PENDING")],
    })).toBe(ContactRequestState.PENDING_ANGEL);
  });
});
