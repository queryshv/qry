import { users, caseRequests, extensionRequests, type User, type InsertUser, type CaseRequest, type InsertCaseRequest, type ExtensionRequest, type InsertExtensionRequest } from "@shared/schema";
import { db } from "./db";
import { eq, desc, sql } from "drizzle-orm";
import session from "express-session";
import connectPg from "connect-pg-simple";
import { pool } from "./db";
import { Storage } from "@google-cloud/storage";
import fs from "fs";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import { log } from "./vite";
import { GoogleCloudStorage } from "./storage/google-cloud";
import { IStorage } from "./types";
import { DatabaseStorage } from "./storage/database";

const PostgresSessionStore = connectPg(session);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function setupGoogleCloudCredentials() {
  const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!credentialsJson) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON environment variable is not set");
  }

  try {
    const credentials = Buffer.from(credentialsJson, 'base64').toString('utf-8');
    const tempCredentialsPath = path.join(process.cwd(), 'google-credentials.json');
    fs.writeFileSync(tempCredentialsPath, credentials);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = tempCredentialsPath;
    process.env.GOOGLE_CLOUD_CREDENTIALS = credentials;
    return tempCredentialsPath;
  } catch (error) {
    console.error("Error setting up Google Cloud credentials:", error);
    throw error;
  }
}

export interface IStorage {
  sessionStore: session.Store;

  // User operations
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: number, updates: Partial<User>): Promise<User>;
  getPendingUsers(): Promise<User[]>;
  getApprovedUsers(): Promise<User[]>;
  approveUser(id: number): Promise<User>;
  rejectUser(id: number, feedback: string): Promise<User>;
  removeUser(id: number): Promise<void>;

  // Case request operations
  getCaseRequest(id: number): Promise<CaseRequest | undefined>;
  createCaseRequest(request: InsertCaseRequest & { userId: number, originalRequestId?: number }): Promise<CaseRequest>;
  getCaseRequestsByUser(userId: number): Promise<CaseRequest[]>;
  getAllCaseRequests(): Promise<CaseRequest[]>;
  updateCaseRequest(id: number, status: string, feedback?: string): Promise<CaseRequest>;
  hideUserCaseRequest(id: number, userId: number): Promise<void>;
  archiveCaseRequest(id: number): Promise<void>;
  deleteCaseRequest(id: number): Promise<void>;

  // Extension request operations
  createExtensionRequest(request: InsertExtensionRequest & { userId: number; status: string }): Promise<ExtensionRequest>;
  getExtensionRequestsByUser(userId: number): Promise<ExtensionRequest[]>;
  getAllExtensionRequests(): Promise<ExtensionRequest[]>;
  updateExtensionRequest(id: number, status: string, feedback?: string): Promise<ExtensionRequest>;
  hideUserExtensionRequest(id: number, userId: number): Promise<void>;
  archiveExtensionRequest(id: number): Promise<void>;
  deleteExtensionRequest(id: number): Promise<void>;
  getExtensionRequest(id: number): Promise<ExtensionRequest | undefined>;
}

// Create storage instance
const storage: IStorage = new DatabaseStorage();

export { storage };

console.log("Note: The first registered account will be made an admin automatically.");

export async function initializeStorage() {
  if (process.env.USE_LOCAL_STORAGE === "true") {
    log("Using local storage");
    return new GoogleCloudStorage(); // This will automatically fall back to local storage
  }

  try {
    const credentialsPath = setupGoogleCloudCredentials();
    log("Google Cloud credentials loaded successfully");
    return new GoogleCloudStorage();
  } catch (error) {
    if (process.env.FALLBACK_TO_LOCAL === "true") {
      log("Failed to initialize Google Cloud Storage, falling back to local storage");
      return new GoogleCloudStorage(); // This will automatically fall back to local storage
    }
    throw error;
  }
}