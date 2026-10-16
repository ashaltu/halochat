import { ApprovalThreshold, ContactRequestState } from "./enums.js";

export interface AngelVote {
  angelUserId: string;
  side: "REQUESTER" | "RECIPIENT";
  status: "PENDING" | "APPROVED" | "DECLINED";
  reasonCode?: string;
  shortReason?: string;
}

export interface SideApprovalResult {
  side: "REQUESTER" | "RECIPIENT";
  isResolved: boolean;
  isApproved: boolean;
  isDeclined: boolean;
}

/**
 * Evaluates whether a side's Angel approvals threshold is satisfied.
 * Default is ANY_ONE: at least one approval is sufficient (D15).
 */
export function evaluateSideApproval(
  threshold: ApprovalThreshold,
  votes: AngelVote[]
): SideApprovalResult {
  if (votes.length === 0) {
    return {
      side: "RECIPIENT",
      isResolved: true,
      isApproved: true,
      isDeclined: false,
    };
  }

  const approvedCount = votes.filter((v) => v.status === "APPROVED").length;
  const declinedCount = votes.filter((v) => v.status === "DECLINED").length;
  const pendingCount = votes.filter((v) => v.status === "PENDING").length;

  if (threshold === ApprovalThreshold.ANY_ONE) {
    if (approvedCount >= 1) {
      return {
        side: votes[0].side,
        isResolved: true,
        isApproved: true,
        isDeclined: false,
      };
    }
    if (pendingCount === 0 && declinedCount === votes.length) {
      return {
        side: votes[0].side,
        isResolved: true,
        isApproved: false,
        isDeclined: true,
      };
    }
    return {
      side: votes[0].side,
      isResolved: false,
      isApproved: false,
      isDeclined: false,
    };
  } else {
    // ALL threshold: every angel must approve
    if (declinedCount > 0) {
      return {
        side: votes[0].side,
        isResolved: true,
        isApproved: false,
        isDeclined: true,
      };
    }
    if (approvedCount === votes.length) {
      return {
        side: votes[0].side,
        isResolved: true,
        isApproved: true,
        isDeclined: false,
      };
    }
    return {
      side: votes[0].side,
      isResolved: false,
      isApproved: false,
      isDeclined: false,
    };
  }
}

/**
 * Evaluates overall contact request state after recipient acceptance.
 */
export function evaluateContactRequestState(params: {
  recipientThreshold: ApprovalThreshold;
  recipientVotes: AngelVote[];
  requesterThreshold: ApprovalThreshold;
  requesterVotes: AngelVote[];
}): ContactRequestState {
  const recipientRes = evaluateSideApproval(params.recipientThreshold, params.recipientVotes);
  const requesterRes = evaluateSideApproval(params.requesterThreshold, params.requesterVotes);

  if (recipientRes.isDeclined || requesterRes.isDeclined) {
    return ContactRequestState.DECLINED_BY_ANGEL;
  }

  if (recipientRes.isApproved && requesterRes.isApproved) {
    return ContactRequestState.ACCEPTED;
  }

  return ContactRequestState.PENDING_ANGEL;
}
