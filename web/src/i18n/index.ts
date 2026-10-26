import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import enUS from "@/i18n/locales/en-US";
import zhCN from "@/i18n/locales/zh-CN";

export type AppLocale = "zh-CN" | "en-US";

const LOCALE_STORAGE_KEY = "infinite-canvas:locale";

/**
 * 读取持久化的语言偏好。
 *
 * 为什么必须做环境判断：模块顶层就会执行这里，而 `localStorage` 是 **Web API**，
 * 在 Node / SSR / 测试环境里根本不存在 —— 直接 `localStorage.getItem` 会抛
 * `ReferenceError: localStorage is not defined`，于是**任何** import 到 i18n 的
 * 测试都在加载阶段就炸掉（不是断言失败，是连跑都跑不起来）。
 *
 * 浏览器里 `typeof localStorage` 必然是 `"undefined"` 之外的取值，行为零变化；
 * 非浏览器则回落到 `"zh-CN"`，这正是原来 `|| "zh-CN"` 想做的事。
 */
function readStoredLocale(): AppLocale | null {
    if (typeof localStorage === "undefined") return null;
    try {
        return localStorage.getItem(LOCALE_STORAGE_KEY) as AppLocale | null;
    } catch {
        // 隐私模式 / 禁用存储时 getItem 会抛，回落默认语言即可。
        return null;
    }
}

/** 写入语言偏好（同样做环境判断：非浏览器环境静默跳过，不打断调用方）。 */
function writeStoredLocale(locale: AppLocale): void {
    if (typeof localStorage === "undefined") return;
    try {
        localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
        // 存不进去不影响切语言本身。
    }
}

i18n.use(initReactI18next).init({
    resources: {
        "zh-CN": { translation: zhCN },
        "en-US": { translation: enUS },
    },
    lng: readStoredLocale() || "zh-CN",
    fallbackLng: "zh-CN",
    supportedLngs: ["zh-CN", "en-US"],
    initAsync: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
});

export function changeAppLocale(locale: AppLocale) {
    writeStoredLocale(locale);
    return i18n.changeLanguage(locale);
}

export default i18n;
