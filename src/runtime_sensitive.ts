// A keyword safety net for "this step needs a person".
//
// **A net, not the main mechanism.** The model judging for itself and setting is_paused is the
// main path; the prompt has a section on it.
//
// **This gate does not accept false positives.** Stopping wrongly interrupts the task and
// costs a person their time, while what it catches is by definition the minority of cases
// where the model slipped. So the lists hold only words that are all but impossible in a
// harmless action — the first version's topic words (sign-in / account / delete / privacy)
// were all removed; see SensitiveWords for why each one had to go.
//
// The price is explicit: a model that walks into a login box without pausing is no longer
// caught here, and that case now falls to the prompt and the deadlock backstop. **The deadlock
// message is deliberately not reworded** to say "looks stuck on a login": that would make the
// stop look tidy while hiding the real problem, which is that the model did not work it out.
//
// **Why no proper i18n.** The main signal is our prompt's language, not the page's — the model
// writes its description in whatever language the prompt and task use. Keyword matching is a
// heuristic that no dictionary or embedding makes complete, and the language-independent
// signals are unusable here because this net only reads what the model writes, never the page.
//
// **Correction on the record**: that last point used to add "annotatedContent does not give the
// input type". The browser has given it since September 2026, and it renders
// `INPUT:password` in the prompt. But that leads to "have this net look at the page too",
// a different piece of work, not more words in the lists.

/**
 * Two lists, differing in **where they are matched**, not in severity.
 *
 * intent is matched only against the description ("what I am about to do"); credential against
 * the result as well ("what I can see"). A payment word is normal in an observation ("supports
 * paying online") and only warrants a stop in an intent ("click Pay"); a password field is
 * abnormal wherever it appears.
 *
 * The topic words removed from the first version, with the normal action each one would have
 * stopped:
 *
 *   privacy   -> "click the privacy policy link"
 *   account   -> "open My Account to see past orders"
 *   delete    -> "delete the item added by mistake" — which may be the task itself
 *   sign in   -> "confirm we are signed in, then continue"
 *   register  -> "tick the registration agreement checkbox"
 *   face      -> "the button face", "face value"
 *   transfer  -> a "transfer flight" is a connecting flight
 */
export interface SensitiveWords {
  /** Intent words: matched only in the description. */
  intent: string[];
  /** Credential words: matched in both the description and the result. */
  credential: string[];
}

export const DEFAULT_SENSITIVE_WORDS: SensitiveWords = {
  // Stop before doing these: irreversible, and real money is involved. Matched only in "what I am about to do".
  //
  // The Chinese terms below are matching data, not prose: pages and model output in Chinese
  // have to be matched in Chinese. Translating them would silently disable the guardrail.
  //
  // "transfer" is deliberately absent: a connecting flight IS a "transfer flight", which is
  // perfectly normal when booking travel. Only the Chinese 转账 is listed, which carries no
  // such ambiguity. Likewise "withdraw" is absent (a withdrawn application is normal) and
  // only 提现 is listed.
  intent: [
    "付款", "支付", "转账", "充值", "结算", "绑卡", "提现",
    "pay", "payment", "checkout",
    "wire transfer", "bank transfer",
  ],
  // Stop on sight: these words are all but impossible in a harmless action, so they are
  // matched against what the agent SEES as well as what it intends. Chinese entries are
  // matching data — see the note above.
  credential: [
    "密码", "口令",
    "验证码", "校验码",
    "两步验证", "二次验证", "双因素",
    "银行卡", "信用卡",
    "身份证", "护照",
    "人脸识别", "指纹", "虹膜",
    "扫码登录", "扫码支付",
    "password", "passwd", "passphrase",
    "captcha", "otp", "one-time", "verification code", "sms code",
    "2fa", "two-factor", "two factor", "authenticator",
    "credit card", "card number", "cvv", "cvc", "iban",
    "passport", "id card", "ssn",
    "biometric", "face recognition", "facial",
  ],
};

/** Only pure ASCII letter / space / hyphen words need word boundaries; Chinese has none. */
function needsBoundary(word: string): boolean {
  return /^[a-z][a-z \-]*$/i.test(word);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns the word that matched, or undefined when nothing did.
 *
 * It returns the word rather than a boolean so it can go into the sentence a person reads:
 * "paused because it mentioned 'pay'" is far more useful than "this is a sensitive action" —
 * and if it did stop wrongly, you can see at a glance which word was to blame.
 *
 * Case-insensitive (`CVV` and `cvv` both count). Latin words require a word boundary, or
 * `pay` matches `payload` and `otp` matches `viewport` — viewport is not hypothetical, the
 * word appears both in our own prompt and in the model's descriptions.
 */
export function matchSensitive(
  text: string,
  words: readonly string[],
): string | undefined {
  if (!text) return undefined;
  const lower = text.toLowerCase();
  for (const word of words) {
    const w = word.toLowerCase();
    if (!w) continue;
    if (needsBoundary(w)) {
      // Uses (?<![a-z]) / (?![a-z]) rather than \b: \b treats Chinese as a word boundary, so
      // "pay" would match inside "支付pay宝" — which it should — but \b also lets "otp" match
      // inside "viewport", because there is no \b between the t and the p.
      // A plural counts ("passwords", "credit cards"). A hyphen is a boundary, so "Pay-Now"
      // matches; the price is that "pay-per-click" does too, which is the rarer of the two.
      const re = new RegExp(`(?<![a-z])${escapeRegExp(w)}(?:e?s)?(?![a-z])`, "i");
      if (re.test(lower)) return word;
    } else if (lower.includes(w)) {
      return word;
    }
  }
  return undefined;
}

/** Does this plan touch something "a person has to do"? Returns the matched word, for use in the wording. */
export function findSensitive(
  parts: { descriptions: string[]; results: string[] },
  words: SensitiveWords = DEFAULT_SENSITIVE_WORDS,
): string | undefined {
  for (const d of parts.descriptions) {
    const hit =
      matchSensitive(d, words.intent) ?? matchSensitive(d, words.credential);
    if (hit) return hit;
  }
  // The result is checked against credential words only: see the note on SensitiveWords.
  for (const r of parts.results) {
    const hit = matchSensitive(r, words.credential);
    if (hit) return hit;
  }
  return undefined;
}
