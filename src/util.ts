import crypto from "node:crypto";

export function generateId(prefix: string): string {
  return `${prefix}:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

export function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}
