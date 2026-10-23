import type { PrismaClient } from '@prisma/client';

/** Data access for users and sessions. The only module that touches Prisma here. */

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  revokedAt: Date | null;
  expiresAt: Date;
}

export interface AuthRepository {
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  createUser(input: {
    email: string;
    passwordHash: string;
    displayName: string;
  }): Promise<UserRecord>;
  createSession(input: {
    userId: string;
    refreshTokenHash: string;
    expiresAt: Date;
  }): Promise<SessionRecord>;
  /** Looks up a session by token hash, whether active or revoked. */
  findSessionByTokenHash(refreshTokenHash: string): Promise<SessionRecord | null>;
  revokeSession(sessionId: string): Promise<void>;
  /** Reuse-detection response: kill every still-active session for this user. */
  revokeAllActiveSessionsForUser(userId: string): Promise<number>;
}

export function createAuthRepository(prisma: PrismaClient): AuthRepository {
  return {
    async findUserByEmail(email: string) {
      return prisma.user.findUnique({ where: { email } });
    },

    async findUserById(id: string) {
      return prisma.user.findUnique({ where: { id } });
    },

    async createUser(input) {
      return prisma.user.create({ data: input });
    },

    async createSession(input) {
      return prisma.session.create({ data: input });
    },

    async findSessionByTokenHash(refreshTokenHash: string) {
      return prisma.session.findUnique({ where: { refreshTokenHash } });
    },

    async revokeSession(sessionId: string) {
      await prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
    },

    async revokeAllActiveSessionsForUser(userId: string) {
      const result = await prisma.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return result.count;
    },
  };
}
