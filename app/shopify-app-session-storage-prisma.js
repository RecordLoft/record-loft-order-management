import { Session } from "@shopify/shopify-api";
import { Prisma } from "../generated/prisma/client";

const UNIQUE_KEY_CONSTRAINT_ERROR_CODE = "P2002";
class PrismaSessionStorage {
  prisma;
  ready;
  tableName = "session";
  connectionRetries = 4;
  connectionRetryIntervalMs = 3000;
  constructor(
    prisma,
    { tableName, connectionRetries, connectionRetryIntervalMs } = {},
  ) {
    this.prisma = prisma;
    if (tableName) {
      this.tableName = tableName;
    }
    if (connectionRetries !== undefined) {
      this.connectionRetries = connectionRetries;
    }
    if (connectionRetryIntervalMs !== undefined) {
      this.connectionRetryIntervalMs = connectionRetryIntervalMs;
    }
    if (this.getSessionTable() === undefined) {
      throw new Error(`PrismaClient does not have a ${this.tableName} table`);
    }
    // Do not throw here — an unhandled rejection kills the Cloud Run process.
    // Aiven timeouts are transient; requests retry via ensureReady().
    this.ready = this.pollForTable()
      .then(() => true)
      .catch((error) => {
        console.error(
          `[session-storage] initial ${this.tableName} probe failed: ${error}`,
        );
        return false;
      });
  }
  async storeSession(session) {
    await this.ensureReady();
    const data = this.sessionToRow(session);
    try {
      await this.getSessionTable().upsert({
        where: { id: session.id },
        update: data,
        create: data,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_KEY_CONSTRAINT_ERROR_CODE
      ) {
        console.log(
          "Caught PrismaClientKnownRequestError P2002 - Unique Key Key Constraint, retrying upsert.",
        );
        await this.getSessionTable().upsert({
          where: { id: session.id },
          update: data,
          create: data,
        });
        return true;
      }
      throw error;
    }
    return true;
  }
  async loadSession(id) {
    await this.ensureReady();
    const row = await this.getSessionTable().findUnique({
      where: { id },
    });
    if (!row) {
      return undefined;
    }
    return this.rowToSession(row);
  }
  async deleteSession(id) {
    await this.ensureReady();
    try {
      await this.getSessionTable().delete({ where: { id } });
    } catch {
      return true;
    }
    return true;
  }
  async deleteSessions(ids) {
    await this.ensureReady();
    await this.getSessionTable().deleteMany({ where: { id: { in: ids } } });
    return true;
  }
  async findSessionsByShop(shop) {
    await this.ensureReady();
    const sessions = await this.getSessionTable().findMany({
      where: { shop },
      take: 25,
      orderBy: [{ expires: "desc" }],
    });
    return sessions.map((session) => this.rowToSession(session));
  }
  async isReady() {
    try {
      await this.pollForTable();
      this.ready = Promise.resolve(true);
    } catch (_error) {
      this.ready = Promise.resolve(false);
    }
    return this.ready;
  }
  async ensureReady() {
    if (await this.ready) return;
    try {
      await this.pollForTable();
      this.ready = Promise.resolve(true);
    } catch (error) {
      console.error(`[session-storage] ${this.tableName} still unreachable: ${error}`);
      throw new MissingSessionStorageError(
        "Prisma session storage is not ready. The database did not accept a connection in time.",
      );
    }
  }
  async pollForTable() {
    let lastError = null;
    for (let i = 0; i < this.connectionRetries; i++) {
      try {
        await this.getSessionTable().count();
        return;
      } catch (error) {
        lastError = error;
        console.error(
          `[session-storage] session count failed (attempt ${i + 1}/${this.connectionRetries}): ${error}`,
        );
      }
      await sleep(this.connectionRetryIntervalMs);
    }
    throw lastError ?? new Error(`Could not query \`${this.tableName}\``);
  }
  sessionToRow(session) {
    const sessionParams = session.toObject();
    return {
      id: session.id,
      shop: session.shop,
      state: session.state,
      isOnline: session.isOnline,
      scope: session.scope || null,
      expires: session.expires || null,
      accessToken: session.accessToken || "",
      userId: sessionParams.onlineAccessInfo?.associated_user.id || null,
      firstName:
        sessionParams.onlineAccessInfo?.associated_user.first_name || null,
      lastName:
        sessionParams.onlineAccessInfo?.associated_user.last_name || null,
      email: sessionParams.onlineAccessInfo?.associated_user.email || null,
      accountOwner:
        sessionParams.onlineAccessInfo?.associated_user.account_owner || false,
      locale: sessionParams.onlineAccessInfo?.associated_user.locale || null,
      collaborator:
        sessionParams.onlineAccessInfo?.associated_user.collaborator || false,
      emailVerified:
        sessionParams.onlineAccessInfo?.associated_user.email_verified || false,
      refreshToken: sessionParams.refreshToken || null,
      refreshTokenExpires: sessionParams.refreshTokenExpires || null,
    };
  }
  rowToSession(row) {
    const sessionParams = {
      id: row.id,
      shop: row.shop,
      state: row.state,
      isOnline: row.isOnline,
      userId: String(row.userId),
      firstName: String(row.firstName),
      lastName: String(row.lastName),
      email: String(row.email),
      locale: String(row.locale),
    };
    if (row.accountOwner !== null) {
      sessionParams.accountOwner = row.accountOwner;
    }
    if (row.collaborator !== null) {
      sessionParams.collaborator = row.collaborator;
    }
    if (row.emailVerified !== null) {
      sessionParams.emailVerified = row.emailVerified;
    }
    if (row.expires) {
      sessionParams.expires = row.expires.getTime();
    }
    if (row.scope) {
      sessionParams.scope = row.scope;
    }
    if (row.accessToken) {
      sessionParams.accessToken = row.accessToken;
    }
    if (row.refreshToken) {
      sessionParams.refreshToken = row.refreshToken;
    }
    if (row.refreshTokenExpires) {
      sessionParams.refreshTokenExpires = row.refreshTokenExpires.getTime();
    }
    return Session.fromPropertyArray(Object.entries(sessionParams), true);
  }
  getSessionTable() {
    return this.prisma[this.tableName];
  }
}
class MissingSessionTableError extends Error {
  cause;
  constructor(message, cause) {
    super(message);
    this.cause = cause;
  }
}
class MissingSessionStorageError extends Error {
  constructor(message) {
    super(message);
  }
}
async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export {
  MissingSessionStorageError,
  MissingSessionTableError,
  PrismaSessionStorage,
};
//# sourceMappingURL=prisma.mjs.map
