// The keyword safety net for "this step needs a person".
//
// **The point of this group is not firing wrongly.** Stopping wrongly costs an interrupted task
// and a person having to take over, while this gate only ever covers the minority of cases where
// the model slipped — so missing one is better than stopping wrongly.
//
// The first version of the lists held topic words like sign-in / account / delete / privacy, and a
// normal action can be constructed for each. The "normal actions all pass" group below is exactly
// those constructions, and every one of them must now pass.
//
// The Chinese phrases below are matching data: the word lists are Chinese, so the cases have to be too.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getSensitiveWords, loadRuntimeConfigFile } from "../../src/runtime_config.js";
import {
  DEFAULT_SENSITIVE_WORDS,
  findSensitive,
  matchSensitive,
} from "../../src/runtime_sensitive.js";

const hit = (description: string, result = "") =>
  findSensitive({ descriptions: [description], results: [result] });

// ---- should be stopped ----

test("credentials: stop on sight", () => {
  for (const t of [
    "输入支付密码",
    "需要输入短信验证码",
    "上传身份证照片",
    "绑定银行卡",
    "点击扫码登录",
    "enter the CVV",
    "a captcha appeared",
    "two-factor authentication required",
    "fill in the card number",
  ]) {
    assert.ok(hit(t), `should be stopped: ${t}`);
  }
});

test("payments: stop before doing it (irreversible, real money)", () => {
  for (const t of ["点击去支付按钮", "进入结算页面", "proceed to checkout", "点击立即付款"]) {
    assert.ok(hit(t), `should be stopped: ${t}`);
  }
});

// ---- should not be stopped: every one is a normal action the first version would have stopped ----

test("normal actions all pass (these are the ones the first version stopped)", () => {
  const benign: Array<[string, string]> = [
    ["点击隐私政策链接查看条款", "the first version's 隐私 / privacy"],
    ["点击我的账号菜单查看历史订单", "the first version's 账号 / account"],
    ["删除购物车里多选的那一项", "the first version's 删除 / delete — and this may be the task itself"],
    ["确认已登录状态后继续下一步", "the first version's 登录"],
    ["点击注册协议复选框", "the first version's 注册 / register"],
    ["关闭登录弹窗，选择低价国航航班进行订票操作", "the first version's 登录"],
    ["选择中转航班 transfer flight", "the bare word transfer — a connecting flight is exactly that"],
    ["click the button face", "the bare word face"],
    ["withdraw the application", "the bare word withdraw"],
    ["check out this hotel", "checkout must not match the separated check out"],
    ["点击搜索按钮，查询深圳飞往北京的机票", "unrelated to begin with"],
    ["点击预订按钮进入预订页", "unrelated to begin with"],
  ];
  for (const [t, why] of benign) {
    assert.equal(hit(t), undefined, `should not be stopped (${why}): ${t}`);
  }
});

test("Latin words require a word boundary and must not match inside another word", () => {
  // The viewport case is not hypothetical — the word appears both in our own prompt and in the
  // model's descriptions, and otp is a substring of it.
  const cases: Array<[string, string]> = [
    ["把 viewport 滚到目标位置", "otp must not match viewport"],
    ["提交 payload 到接口", "pay must not match payload"],
    ["打开 payphone 页面", "pay must not match payphone"],
  ];
  for (const [text, why] of cases) {
    assert.equal(hit(text), undefined, why);
  }
});

test("a plural is the same word; a longer word that merely starts with it is not", () => {
  for (const t of ["enter the passwords", "saved credit cards", "review the payments", "click Pay-Now"]) {
    assert.ok(hit(t), `should be stopped: ${t}`);
  }
  for (const t of ["open the payslip", "check the passengers"]) {
    assert.equal(hit(t), undefined, `should not be stopped: ${t}`);
  }
});

test("a whole word still matches even when pressed against Chinese (Chinese has no word boundary)", () => {
  assert.ok(hit("走 pay 通道结账"));
  assert.ok(matchSensitive("点 Pay 按钮", DEFAULT_SENSITIVE_WORDS.intent));
});

// ---- where each list is matched ----

test("payment words look at intent only, never at observation", () => {
  // "This flight supports paying online" describes the page; it is not going to pay. Pausing on it is a false positive.
  assert.equal(
    findSensitive({
      descriptions: ["点击预订按钮"],
      results: ["该航班支持在线支付，页面显示支付方式有三种"],
    }),
    undefined,
  );
  // The same word inside "what I am about to do" should be stopped.
  assert.equal(
    findSensitive({ descriptions: ["点击去支付"], results: [] }),
    "支付",
  );
});

test("credential words look at the observation too — seeing a password box is not a normal situation", () => {
  assert.equal(
    findSensitive({
      descriptions: ["点击预订按钮"],
      results: ["页面弹出了要求输入密码的对话框"],
    }),
    "密码",
  );
});

test("both descriptions are checked (this step and the next)", () => {
  assert.equal(
    findSensitive({ descriptions: ["点搜索", "输入支付密码"], results: [] }),
    "支付",
  );
});

// ---- the rest ----

test("case insensitive", () => {
  assert.ok(hit("enter PASSWORD"));
  assert.ok(hit("Proceed To Checkout"));
});

test("returns the matched word rather than a boolean — if it stops wrongly you must see which word did it", () => {
  assert.equal(hit("点击去支付按钮"), "支付");
  assert.equal(hit("enter the CVV"), "cvv");
});

test("empty input does not blow up", () => {
  assert.equal(findSensitive({ descriptions: [], results: [] }), undefined);
  assert.equal(findSensitive({ descriptions: ["", ""], results: [""] }), undefined);
});

test("a list can be replaced wholesale (adding a language is a config change, not a code change)", () => {
  const custom = { intent: ["決済"], credential: ["パスワード"] };
  assert.equal(
    findSensitive({ descriptions: ["決済ボタンをクリック"], results: [] }, custom),
    "決済",
  );
  // After replacing the list, the default words must no longer match — that is what "replace" means, as opposed to "append".
  assert.equal(
    findSensitive({ descriptions: ["点击去支付"], results: [] }, custom),
    undefined,
  );
});

test("an empty word in a configured list is skipped, not taken as matching everything", () => {
  // "".includes("") is true; without the skip one stray blank entry would stop every step.
  assert.equal(matchSensitive("click search", [""]), undefined);
});

test("a multi-word Latin term needs a boundary at both ends, and matches across case", () => {
  assert.equal(hit("Enter the Verification Code sent to you"), "verification code");
  assert.equal(hit("a one-timer offer banner"), undefined, "one-time must not match inside one-timer");
});

test("configured lists: an empty or blank list keeps the default instead of switching the net off", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browserdo-sens-"));
  try {
    const file = path.join(dir, "browserdo.config.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        guardrail: { sensitiveIntent: [], sensitiveCredential: ["  cvv  ", null, "", 42] },
      }),
      "utf8",
    );
    loadRuntimeConfigFile(file);
    const got = getSensitiveWords();
    assert.equal(got.intent, undefined, "an empty list must not replace the defaults with nothing");
    assert.deepEqual(got.credential, ["cvv", "42"], "entries are trimmed; null and blanks dropped");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the default lists hold none of the topic words that fire wrongly", () => {
  // A regression guard: someone later wanting to "catch a bit more" by adding 登录/账号/删除 is stopped
  // here. Before adding one, work out whether a normal description exists that should pass and would be stopped.
  const all = [
    ...DEFAULT_SENSITIVE_WORDS.intent,
    ...DEFAULT_SENSITIVE_WORDS.credential,
  ].map((w) => w.toLowerCase());
  for (const banned of [
    "登录",
    "注册",
    "账号",
    "账户",
    "删除",
    "隐私",
    "login",
    "sign in",
    "account",
    "delete",
    "remove",
    "privacy",
    "face",
    "transfer",
    "withdraw",
    "用户名",
    "username",
  ]) {
    assert.ok(
      !all.includes(banned),
      `"${banned}" fires wrongly and must not be in the default lists — for the reasoning see the list in runtime_sensitive.ts`,
    );
  }
});
