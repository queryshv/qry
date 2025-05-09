import { IStorage } from "../types";
import { User, InsertUser, CaseRequest, InsertCaseRequest, ExtensionRequest, InsertExtensionRequest, users, caseRequests, extensionRequests } from "@shared/schema";
import { db } from "../db";
import { eq, desc, sql } from "drizzle-orm";
import session from "express-session";
import connectPg from "connect-pg-simple";
import { pool } from "../db";

const PostgresSessionStore = connectPg(session);

export class DatabaseStorage implements IStorage {
  sessionStore: session.Store;

  constructor() {
    this.sessionStore = new PostgresSessionStore({
      pool,
      createTableIfMissing: true,
    });
  }

  // User operations
  async getUser(id: number): Promise<User | undefined> {
    try {
      const [user] = await db.select().from(users).where(eq(users.id, id));
      return user;
    } catch (error) {
      console.error('Error getting user:', error);
      return undefined;
    }
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    try {
      const [user] = await db.select().from(users).where(eq(users.username, username));
      return user;
    } catch (error) {
      console.error('Error getting user by username:', error);
      return undefined;
    }
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    try {
      const [user] = await db.select().from(users).where(eq(users.email, email));
      return user;
    } catch (error) {
      console.error('Error getting user by email:', error);
      return undefined;
    }
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    // Check if this is the first user
    const existingUsers = await db.select().from(users);
    const isFirstUser = existingUsers.length === 0;

    const [user] = await db.insert(users).values({
      ...insertUser,
      isAdmin: isFirstUser,
      isApproved: isFirstUser,
      registrationDate: new Date(),
    }).returning();

    return user;
  }

  async updateUser(id: number, updates: Partial<User>): Promise<User> {
    const [user] = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, id))
      .returning();
    return user;
  }

  async getPendingUsers(): Promise<User[]> {
    return db
      .select()
      .from(users)
      .where(eq(users.isApproved, false));
  }

  async getApprovedUsers(): Promise<User[]> {
    return db
      .select()
      .from(users)
      .where(eq(users.isApproved, true))
      .orderBy(desc(users.registrationDate));
  }

  async approveUser(id: number): Promise<User> {
    const [user] = await db
      .update(users)
      .set({ isApproved: true })
      .where(eq(users.id, id))
      .returning();
    return user;
  }

  async rejectUser(id: number, feedback: string): Promise<User> {
    const [user] = await db
      .update(users)
      .set({
        approvalFeedback: feedback,
        isApproved: false
      })
      .where(eq(users.id, id))
      .returning();
    return user;
  }

  async removeUser(id: number): Promise<void> {
    await db.delete(users).where(eq(users.id, id));
  }

  // Case request operations
  async getCaseRequest(id: number): Promise<CaseRequest | undefined> {
    try {
      const [request] = await db
        .select()
        .from(caseRequests)
        .where(eq(caseRequests.id, id));
      return request;
    } catch (error) {
      console.error('Error getting case request:', error);
      return undefined;
    }
  }

  async createCaseRequest(request: InsertCaseRequest & { userId: number, originalRequestId?: number }): Promise<CaseRequest> {
    const now = new Date();
    let changes: { field: string; from: string; to: string; }[] = [];

    // If this is a resubmission, compare with original request
    if (request.originalRequestId) {
      const originalRequest = await db
        .select()
        .from(caseRequests)
        .where(eq(caseRequests.id, request.originalRequestId))
        .limit(1);

      if (originalRequest.length > 0) {
        const original = originalRequest[0];
        const fieldsToCompare = [
          'sadNumber', 'sadDate', 'declarantCompany', 'declarantName',
          'documentHolder', 'documentHolderPhone', 'reason'
        ] as const;

        changes = fieldsToCompare
          .filter(field => original[field] !== (request as any)[field])
          .map(field => ({
            field,
            from: String(original[field]),
            to: String((request as any)[field])
          }));

        // Compare corrections array
        if (JSON.stringify(original.corrections) !== JSON.stringify((request as any).corrections)) {
          changes.push({
            field: 'corrections',
            from: JSON.stringify(original.corrections),
            to: JSON.stringify((request as any).corrections)
          });
        }
      }
    }

    const [caseRequest] = await db
      .insert(caseRequests)
      .values({
        ...request,
        type: 'case' as const,
        isResubmission: !!request.originalRequestId,
        originalRequestId: request.originalRequestId,
        changes: changes.length > 0 ? changes : null,
        status: request.originalRequestId ? "resubmitted" : "submitted",
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return caseRequest;
  }

  async getCaseRequestsByUser(userId: number): Promise<CaseRequest[]> {
    try {
      console.log(`[Storage] Getting case requests for user: ${userId}`);
      const requests = await db
        .select()
        .from(caseRequests)
        .where(eq(caseRequests.userId, userId))
        .where(sql`NOT ${caseRequests.hiddenBy}::jsonb @> ${JSON.stringify([userId])}::jsonb`)
        .where(eq(caseRequests.isArchived, false))
        .orderBy(desc(caseRequests.createdAt));

      console.log(`[Storage] Found ${requests.length} case requests for user ${userId}`);
      return requests;
    } catch (error) {
      console.error('[Storage] Error getting case requests:', error);
      return [];
    }
  }

  async getAllCaseRequests(): Promise<CaseRequest[]> {
    return db
      .select()
      .from(caseRequests)
      .where(eq(caseRequests.isArchived, false))
      .orderBy(desc(caseRequests.createdAt));
  }

  async updateCaseRequest(id: number, status: string, feedback?: string): Promise<CaseRequest> {
    try {
      console.log(`[Storage] Attempting to update case request ${id} to status: ${status}`);

      const existingRequest = await db
        .select()
        .from(caseRequests)
        .where(eq(caseRequests.id, id))
        .limit(1);

      if (!existingRequest.length) {
        console.error(`[Storage] Case request ${id} not found`);
        throw new Error(`Request with ID ${id} not found`);
      }

      const currentStatus = existingRequest[0].status;
      const validTransitions: Record<string, string[]> = {
        'submitted': ['pending', 'rejected'],
        'pending': ['complete', 'rejected'],
        'rejected': [],
        'complete': [],
        'resubmitted': ['pending', 'rejected']
      };

      if (!validTransitions[currentStatus]?.includes(status)) {
        console.error(`[Storage] Invalid status transition from ${currentStatus} to ${status}`);
        throw new Error(`Invalid status transition from ${currentStatus} to ${status}`);
      }

      const [request] = await db
        .update(caseRequests)
        .set({
          status,
          adminFeedback: feedback,
          updatedAt: new Date(),
          completedAt: status === 'complete' ? new Date() : undefined,
          receivedAt: status === 'pending' ? new Date() : undefined
        })
        .where(eq(caseRequests.id, id))
        .returning();

      if (!request) {
        console.error(`[Storage] Failed to update case request ${id}`);
        throw new Error('Failed to update case request');
      }

      console.log(`[Storage] Successfully updated case request ${id} to status: ${status}`);
      return request;
    } catch (error) {
      console.error('[Storage] Error updating case request:', error);
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Failed to update case request');
    }
  }

  async hideUserCaseRequest(id: number, userId: number): Promise<void> {
    const [request] = await db
      .select()
      .from(caseRequests)
      .where(eq(caseRequests.id, id));

    if (!request) {
      throw new Error('Request not found');
    }

    const hiddenBy = [...(request.hiddenBy || []), userId];

    await db
      .update(caseRequests)
      .set({ hiddenBy })
      .where(eq(caseRequests.id, id));
  }

  async archiveCaseRequest(id: number): Promise<void> {
    await db
      .update(caseRequests)
      .set({ isArchived: true })
      .where(eq(caseRequests.id, id));
  }

  async deleteCaseRequest(id: number): Promise<void> {
    await db.delete(caseRequests).where(eq(caseRequests.id, id));
  }

  // Extension request operations
  async getExtensionRequest(id: number): Promise<ExtensionRequest | undefined> {
    try {
      const [request] = await db
        .select()
        .from(extensionRequests)
        .where(eq(extensionRequests.id, id));
      return request;
    } catch (error) {
      console.error('Error getting extension request:', error);
      return undefined;
    }
  }

  async createExtensionRequest(request: InsertExtensionRequest & { userId: number; status: string }): Promise<ExtensionRequest> {
    const now = new Date();
    const [extensionRequest] = await db
      .insert(extensionRequests)
      .values({
        ...request,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return extensionRequest;
  }

  async getExtensionRequestsByUser(userId: number): Promise<ExtensionRequest[]> {
    return db
      .select()
      .from(extensionRequests)
      .where(eq(extensionRequests.userId, userId))
      .where(sql`NOT ${extensionRequests.hiddenBy}::jsonb @> ${JSON.stringify([userId])}::jsonb`)
      .where(eq(extensionRequests.isArchived, false))
      .orderBy(desc(extensionRequests.createdAt));
  }

  async getAllExtensionRequests(): Promise<ExtensionRequest[]> {
    return db
      .select()
      .from(extensionRequests)
      .where(eq(extensionRequests.isArchived, false))
      .orderBy(desc(extensionRequests.createdAt));
  }

  async updateExtensionRequest(id: number, status: string, feedback?: string): Promise<ExtensionRequest> {
    try {
      console.log(`[Storage] Attempting to update extension request ${id} to status: ${status}`);

      const existingRequest = await db
        .select()
        .from(extensionRequests)
        .where(eq(extensionRequests.id, id))
        .limit(1);

      if (!existingRequest.length) {
        console.error(`[Storage] Extension request ${id} not found`);
        throw new Error(`Request with ID ${id} not found`);
      }

      const currentStatus = existingRequest[0].status;
      const validTransitions: Record<string, string[]> = {
        'submitted': ['pending', 'rejected'],
        'pending': ['complete', 'rejected'],
        'rejected': [],
        'complete': []
      };

      if (!validTransitions[currentStatus]?.includes(status)) {
        console.error(`[Storage] Invalid status transition from ${currentStatus} to ${status}`);
        throw new Error(`Invalid status transition from ${currentStatus} to ${status}`);
      }

      const [request] = await db
        .update(extensionRequests)
        .set({
          status,
          adminFeedback: feedback,
          updatedAt: new Date(),
          completedAt: status === 'complete' ? new Date() : undefined,
          receivedAt: status === 'pending' ? new Date() : undefined
        })
        .where(eq(extensionRequests.id, id))
        .returning();

      if (!request) {
        console.error(`[Storage] Failed to update extension request ${id}`);
        throw new Error('Failed to update extension request');
      }

      console.log(`[Storage] Successfully updated extension request ${id} to status: ${status}`);
      return request;
    } catch (error) {
      console.error('[Storage] Error updating extension request:', error);
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Failed to update extension request');
    }
  }

  async hideUserExtensionRequest(id: number, userId: number): Promise<void> {
    const [request] = await db
      .select()
      .from(extensionRequests)
      .where(eq(extensionRequests.id, id));

    if (!request) {
      throw new Error('Request not found');
    }

    const hiddenBy = [...(request.hiddenBy || []), userId];

    await db
      .update(extensionRequests)
      .set({ hiddenBy })
      .where(eq(extensionRequests.id, id));
  }

  async archiveExtensionRequest(id: number): Promise<void> {
    await db
      .update(extensionRequests)
      .set({ isArchived: true })
      .where(eq(extensionRequests.id, id));
  }

  async deleteExtensionRequest(id: number): Promise<void> {
    await db.delete(extensionRequests).where(eq(extensionRequests.id, id));
  }
} 