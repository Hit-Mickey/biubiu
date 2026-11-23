import { addToast } from "@heroui/react";

export interface GeetestResult {
  validate: string;
  seccode: string;
  challenge: string;
  token: string;
  gt: string;
}

export const loadGeetestScript = () => {
  if (typeof window.initGeetest === "function") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://static.geetest.com/static/tools/gt.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Geetest script"));
    document.body.appendChild(script);
  });
};

interface GetCaptchaParamsResponse {
  code: number;
  message: string;
  data?: {
    token?: string;
    geetest?: {
      gt?: string;
      challenge?: string;
    };
  } | null;
}

export const verifyGeetest = async (
  getCaptchaParams: () => Promise<GetCaptchaParamsResponse>,
): Promise<GeetestResult | null> => {
  try {
    const res = await getCaptchaParams();
    if (res.code !== 0) {
      const message = res.message?.trim();
      addToast({
        title: message && !/^(ok|success|0)$/i.test(message) ? message : "获取验证码失败，请重试",
        color: "danger",
      });
      return null;
    }
    if (!res.data?.geetest?.gt || !res.data.geetest.challenge || !res.data.token) {
      addToast({ title: "当前验证方式不可用，请在哔哩哔哩完成验证后重试", color: "warning" });
      return null;
    }

    await loadGeetestScript();
    const { gt, challenge } = res.data.geetest;
    const { token } = res.data;

    return new Promise<GeetestResult | null>(resolve => {
      if (typeof window.initGeetest !== "function") {
        addToast({ title: "极验组件加载失败", color: "danger" });
        resolve(null);
        return;
      }

      window.initGeetest(
        {
          gt,
          challenge,
          offline: false,
          new_captcha: true,
          product: "bind",
          https: true,
        },
        captchaObj => {
          captchaObj.onReady(() => {
            captchaObj.verify();
          });
          captchaObj.onSuccess(() => {
            const result = captchaObj.getValidate();
            if (result && typeof result !== "boolean") {
              resolve({
                validate: result.geetest_validate || "",
                seccode: result.geetest_seccode || "",
                challenge: result.geetest_challenge || challenge,
                token,
                gt,
              });
            } else {
              resolve(null);
            }
          });
          captchaObj.onError(() => {
            addToast({ title: "验证出错", color: "danger" });
            resolve(null);
          });

          if (captchaObj.onClose) {
            captchaObj.onClose(() => {
              resolve(null);
            });
          }
        },
      );
    });
  } catch (err) {
    addToast({ title: err instanceof Error ? err.message : "验证过程异常", color: "danger" });
    return null;
  }
};
