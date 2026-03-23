import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";

const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_ILINK_BOT_TYPE = "3";
const MAX_QR_REFRESH_COUNT = 3;

type ActiveLogin = {
  sessionKey: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  status?: "wait" | "scaned" | "confirmed" | "expired";
};

const activeLogins = new Map<string, ActiveLogin>();

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface StatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

function isLoginFresh(login: ActiveLogin): boolean {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}

function purgeExpiredLogins(): void {
  for (const [id, login] of activeLogins) {
    if (!isLoginFresh(login)) activeLogins.delete(id);
  }
}

async function fetchQRCode(apiBaseUrl: string, botType: string): Promise<QRCodeResponse> {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, base);
  logger.info(`Fetching QR code from: ${url.toString()}`);

  const response = await fetch(url.toString());
  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    throw new Error(`Failed to fetch QR code: ${response.status} ${response.statusText} body=${body}`);
  }
  return (await response.json()) as QRCodeResponse;
}

async function pollQRStatus(apiBaseUrl: string, qrcode: string): Promise<StatusResponse> {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base);

  const headers: Record<string, string> = {
    "iLink-App-ClientVersion": "1",
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), { headers, signal: controller.signal });
    clearTimeout(timer);
    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`Failed to poll QR status: ${response.status} ${response.statusText}`);
    }
    return JSON.parse(rawText) as StatusResponse;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    throw err;
  }
}

export type LoginResult = {
  connected: boolean;
  botToken?: string;
  accountId?: string;
  baseUrl?: string;
  userId?: string;
  message: string;
};

/**
 * Full QR login flow: fetch QR → display → poll until confirmed.
 * Returns credentials on success.
 */
export async function loginWithQR(opts?: {
  apiBaseUrl?: string;
  timeoutMs?: number;
}): Promise<LoginResult> {
  const apiBaseUrl = opts?.apiBaseUrl ?? "https://ilinkai.weixin.qq.com";
  const timeoutMs = opts?.timeoutMs ?? 480_000;
  const sessionKey = randomUUID();

  purgeExpiredLogins();

  // Step 1: fetch QR code
  let qrResponse: QRCodeResponse;
  try {
    qrResponse = await fetchQRCode(apiBaseUrl, DEFAULT_ILINK_BOT_TYPE);
  } catch (err) {
    return { connected: false, message: `Failed to get QR code: ${String(err)}` };
  }

  const login: ActiveLogin = {
    sessionKey,
    qrcode: qrResponse.qrcode,
    qrcodeUrl: qrResponse.qrcode_img_content,
    startedAt: Date.now(),
  };
  activeLogins.set(sessionKey, login);

  // Step 2: display QR in terminal
  console.log("\n使用微信扫描以下二维码，以完成连接:\n");
  try {
    const qrterm = await import("qrcode-terminal");
    await new Promise<void>((resolve) => {
      qrterm.default.generate(login.qrcodeUrl, { small: true }, (qr: string) => {
        console.log(qr);
        resolve();
      });
    });
  } catch {
    console.log(`QR Code URL: ${login.qrcodeUrl}`);
  }

  // Step 3: poll until confirmed or timeout
  const deadline = Date.now() + timeoutMs;
  let scannedPrinted = false;
  let qrRefreshCount = 1;

  console.log("等待扫码...\n");

  while (Date.now() < deadline) {
    try {
      const statusResponse = await pollQRStatus(apiBaseUrl, login.qrcode);

      switch (statusResponse.status) {
        case "wait":
          break;

        case "scaned":
          if (!scannedPrinted) {
            console.log("👀 已扫码，在微信继续操作...");
            scannedPrinted = true;
          }
          break;

        case "expired": {
          qrRefreshCount++;
          if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
            activeLogins.delete(sessionKey);
            return { connected: false, message: "登录超时: 二维码多次过期" };
          }
          console.log(`\n⏳ 二维码已过期，正在刷新...(${qrRefreshCount}/${MAX_QR_REFRESH_COUNT})`);
          try {
            const newQr = await fetchQRCode(apiBaseUrl, DEFAULT_ILINK_BOT_TYPE);
            login.qrcode = newQr.qrcode;
            login.qrcodeUrl = newQr.qrcode_img_content;
            login.startedAt = Date.now();
            scannedPrinted = false;
            console.log("🔄 新二维码已生成，请重新扫描\n");
            try {
              const qrterm = await import("qrcode-terminal");
              qrterm.default.generate(newQr.qrcode_img_content, { small: true });
            } catch {
              console.log(`QR Code URL: ${newQr.qrcode_img_content}`);
            }
          } catch (refreshErr) {
            activeLogins.delete(sessionKey);
            return { connected: false, message: `刷新二维码失败: ${String(refreshErr)}` };
          }
          break;
        }

        case "confirmed": {
          activeLogins.delete(sessionKey);
          if (!statusResponse.ilink_bot_id) {
            return { connected: false, message: "登录失败: 服务器未返回 ilink_bot_id" };
          }
          logger.info(`Login confirmed: bot_id=${statusResponse.ilink_bot_id}`);
          return {
            connected: true,
            botToken: statusResponse.bot_token,
            accountId: statusResponse.ilink_bot_id,
            baseUrl: statusResponse.baseurl,
            userId: statusResponse.ilink_user_id,
            message: "✅ 与微信连接成功!",
          };
        }
      }
    } catch (err) {
      activeLogins.delete(sessionKey);
      return { connected: false, message: `Login failed: ${String(err)}` };
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  activeLogins.delete(sessionKey);
  return { connected: false, message: "登录超时，请重试。" };
}
