/**
 * Agent Collaboration Protocol
 *
 * Structured agent-to-agent task protocol with lifecycle management and escrow.
 * Tasks flow: pending → accepted → in_progress → delivered → verified → paid
 */

import { ulid } from "ulid";
import type { SocialClientInterface } from "../types.js";

// ─── Types ───────────────────────────────────────────────────────

export type CollabTaskStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "in_progress"
  | "delivered"
  | "verified"
  | "paid"
  | "disputed"
  | "cancelled";

export interface CollabTask {
  id: string;
  requesterAddress: string;
  workerAddress: string;
  description: string;
  requirements: string[];
  paymentOfferCents: number;
  deadline?: string; // ISO timestamp
  status: CollabTaskStatus;
  counterOfferCents?: number;
  counterMessage?: string;
  deliverables?: string;
  verificationNotes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EscrowEntry {
  taskId: string;
  requesterAddress: string;
  amountCents: number;
  status: "held" | "released" | "refunded";
  createdAt: string;
  resolvedAt?: string;
}

export interface CollabMessage {
  protocol: "collab/v1";
  type:
    | "task_request"
    | "task_response"
    | "task_deliver"
    | "task_verify"
    | "task_status";
  taskId: string;
  payload: Record<string, unknown>;
}

// ─── Valid state transitions ─────────────────────────────────────

const VALID_TRANSITIONS: Record<CollabTaskStatus, CollabTaskStatus[]> = {
  pending: ["accepted", "rejected", "cancelled"],
  accepted: ["in_progress", "cancelled"],
  rejected: [],
  in_progress: ["delivered", "cancelled"],
  delivered: ["verified", "disputed"],
  verified: ["paid"],
  paid: [],
  disputed: ["in_progress", "cancelled"],
  cancelled: [],
};

export function canTransition(from: CollabTaskStatus, to: CollabTaskStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ─── In-memory store (would be DB-backed in production) ──────────

export class CollaborationManager {
  private tasks: Map<string, CollabTask> = new Map();
  private escrow: Map<string, EscrowEntry> = new Map();
  private social: SocialClientInterface | null;
  private selfAddress: string;

  constructor(selfAddress: string, social?: SocialClientInterface) {
    this.selfAddress = selfAddress.toLowerCase();
    this.social = social ?? null;
  }

  // ─── Task Creation ──────────────────────────────────────────

  async requestTask(
    workerAddress: string,
    description: string,
    requirements: string[],
    paymentOfferCents: number,
    deadline?: string,
  ): Promise<CollabTask> {
    const task: CollabTask = {
      id: ulid(),
      requesterAddress: this.selfAddress,
      workerAddress: workerAddress.toLowerCase(),
      description,
      requirements,
      paymentOfferCents,
      deadline,
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.tasks.set(task.id, task);

    // Create escrow hold
    this.escrow.set(task.id, {
      taskId: task.id,
      requesterAddress: this.selfAddress,
      amountCents: paymentOfferCents,
      status: "held",
      createdAt: new Date().toISOString(),
    });

    // Send via social relay
    await this.sendCollabMessage(workerAddress, {
      protocol: "collab/v1",
      type: "task_request",
      taskId: task.id,
      payload: {
        description,
        requirements,
        paymentOfferCents,
        deadline,
        requesterAddress: this.selfAddress,
      },
    });

    return task;
  }

  // ─── Task Response ──────────────────────────────────────────

  async respondToTask(
    taskId: string,
    action: "accept" | "reject" | "negotiate",
    counterOfferCents?: number,
    counterMessage?: string,
  ): Promise<CollabTask> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    if (task.workerAddress !== this.selfAddress) {
      throw new Error("Only the assigned worker can respond to this task");
    }

    let newStatus: CollabTaskStatus;
    if (action === "accept") {
      if (!canTransition(task.status, "accepted")) {
        throw new Error(`Cannot accept task in status: ${task.status}`);
      }
      newStatus = "accepted";
    } else if (action === "reject") {
      if (!canTransition(task.status, "rejected")) {
        throw new Error(`Cannot reject task in status: ${task.status}`);
      }
      newStatus = "rejected";
      // Refund escrow
      this.refundEscrow(taskId);
    } else {
      // negotiate — keep pending, attach counter-offer
      newStatus = "pending";
    }

    task.status = newStatus;
    task.counterOfferCents = counterOfferCents;
    task.counterMessage = counterMessage;
    task.updatedAt = new Date().toISOString();

    if (action === "negotiate" && counterOfferCents !== undefined) {
      // Update escrow to new amount
      const entry = this.escrow.get(taskId);
      if (entry) entry.amountCents = counterOfferCents;
    }

    await this.sendCollabMessage(task.requesterAddress, {
      protocol: "collab/v1",
      type: "task_response",
      taskId,
      payload: { action, counterOfferCents, counterMessage, status: newStatus },
    });

    return task;
  }

  // ─── Start Work ─────────────────────────────────────────────

  startWork(taskId: string): CollabTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (!canTransition(task.status, "in_progress")) {
      throw new Error(`Cannot start work on task in status: ${task.status}`);
    }
    task.status = "in_progress";
    task.updatedAt = new Date().toISOString();
    return task;
  }

  // ─── Delivery ───────────────────────────────────────────────

  async deliverTask(taskId: string, deliverables: string): Promise<CollabTask> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.workerAddress !== this.selfAddress) {
      throw new Error("Only the worker can deliver");
    }
    if (!canTransition(task.status, "delivered")) {
      throw new Error(`Cannot deliver task in status: ${task.status}`);
    }

    task.status = "delivered";
    task.deliverables = deliverables;
    task.updatedAt = new Date().toISOString();

    await this.sendCollabMessage(task.requesterAddress, {
      protocol: "collab/v1",
      type: "task_deliver",
      taskId,
      payload: { deliverables },
    });

    return task;
  }

  // ─── Verification ──────────────────────────────────────────

  async verifyDelivery(
    taskId: string,
    approved: boolean,
    notes?: string,
  ): Promise<CollabTask> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.requesterAddress !== this.selfAddress) {
      throw new Error("Only the requester can verify delivery");
    }

    if (approved) {
      if (!canTransition(task.status, "verified")) {
        throw new Error(`Cannot verify task in status: ${task.status}`);
      }
      task.status = "verified";
      task.verificationNotes = notes;
    } else {
      if (!canTransition(task.status, "disputed")) {
        throw new Error(`Cannot dispute task in status: ${task.status}`);
      }
      task.status = "disputed";
      task.verificationNotes = notes;
    }

    task.updatedAt = new Date().toISOString();

    await this.sendCollabMessage(task.workerAddress, {
      protocol: "collab/v1",
      type: "task_verify",
      taskId,
      payload: { approved, notes },
    });

    return task;
  }

  // ─── Payment Release ───────────────────────────────────────

  releasePayment(taskId: string): CollabTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (!canTransition(task.status, "paid")) {
      throw new Error(`Cannot pay task in status: ${task.status}`);
    }

    task.status = "paid";
    task.updatedAt = new Date().toISOString();

    // Release escrow
    const entry = this.escrow.get(taskId);
    if (entry) {
      entry.status = "released";
      entry.resolvedAt = new Date().toISOString();
    }

    return task;
  }

  // ─── Cancel ─────────────────────────────────────────────────

  cancelTask(taskId: string): CollabTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (!canTransition(task.status, "cancelled")) {
      throw new Error(`Cannot cancel task in status: ${task.status}`);
    }

    task.status = "cancelled";
    task.updatedAt = new Date().toISOString();
    this.refundEscrow(taskId);
    return task;
  }

  // ─── Queries ────────────────────────────────────────────────

  getTask(taskId: string): CollabTask | undefined {
    return this.tasks.get(taskId);
  }

  getEscrow(taskId: string): EscrowEntry | undefined {
    return this.escrow.get(taskId);
  }

  listTasks(filter?: {
    role?: "requester" | "worker";
    status?: CollabTaskStatus;
  }): CollabTask[] {
    let tasks = Array.from(this.tasks.values());

    if (filter?.role === "requester") {
      tasks = tasks.filter((t) => t.requesterAddress === this.selfAddress);
    } else if (filter?.role === "worker") {
      tasks = tasks.filter((t) => t.workerAddress === this.selfAddress);
    }

    if (filter?.status) {
      tasks = tasks.filter((t) => t.status === filter.status);
    }

    return tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getTotalEscrowHeld(): number {
    let total = 0;
    for (const entry of this.escrow.values()) {
      if (entry.status === "held") total += entry.amountCents;
    }
    return total;
  }

  // ─── Incoming message handler ───────────────────────────────

  handleIncomingMessage(from: string, content: string): CollabMessage | null {
    try {
      const msg = JSON.parse(content) as CollabMessage;
      if (msg.protocol !== "collab/v1") return null;

      // Store/update task from incoming messages
      if (msg.type === "task_request") {
        const p = msg.payload;
        const task: CollabTask = {
          id: msg.taskId,
          requesterAddress: (p.requesterAddress as string).toLowerCase(),
          workerAddress: this.selfAddress,
          description: p.description as string,
          requirements: p.requirements as string[],
          paymentOfferCents: p.paymentOfferCents as number,
          deadline: p.deadline as string | undefined,
          status: "pending",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        this.tasks.set(task.id, task);
      }

      return msg;
    } catch {
      return null;
    }
  }

  // ─── Private helpers ────────────────────────────────────────

  private refundEscrow(taskId: string): void {
    const entry = this.escrow.get(taskId);
    if (entry && entry.status === "held") {
      entry.status = "refunded";
      entry.resolvedAt = new Date().toISOString();
    }
  }

  private async sendCollabMessage(to: string, msg: CollabMessage): Promise<void> {
    if (!this.social) return;
    try {
      await this.social.send(to, JSON.stringify(msg));
    } catch {
      // Best-effort delivery
    }
  }
}
