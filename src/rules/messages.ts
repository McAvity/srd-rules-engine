/**
 * Message templates (a small subset of ICU MessageFormat) and rendering. An app translates a
 * `Message` by rendering it with its own catalog (same codes, its own templates):
 *
 * - `{name}`: a parameter (a nested message is rendered with the same catalog; a list is joined
 *   with the catalog's `list.comma`);
 * - `{name, list}` / `{name, list, plus}` / `{name, list, semicolon}` / `{name, list, or}` /
 *   `{name, list, and}`: a list joined with the catalog's `list.comma`, `list.plus`,
 *   `list.semicolon`, `list.or` or `list.and` (English when the catalog lacks it);
 * - `{n, plural, one {…} other {…}}` (also `=0 {…}`, and `zero`, `two`, `few`, `many`): by the
 *   number, `#` standing for it: an exact `=n` first, then the category the language's rules give
 *   (`Intl.PluralRules` for the `locale` rendered with, English by default), then `other`;
 * - `{key, select, a {…} b {…} other {…}}`: by the value (`true`/`false` for a boolean).
 */

import { MESSAGES_EN, type MessageCode } from "../messages/en";
import type { Message, MessageParam } from "../models/messages";

export type MessageCatalog = Readonly<Record<string, string>>;

/** How to render: the `locale` whose plural rules pick a `plural` option (default `en`). */
export interface RenderOptions {
  readonly locale?: string;
}

type Node =
  | string
  | { arg: string; kind: "value" | "list"; style: string | null }
  | { arg: string; kind: "plural" | "select"; options: Record<string, Node[]> }
  | { hash: true };

const pluralRules = new Map<string, Intl.PluralRules>();
/** The plural category of `n` in `locale` (`one`, `few`, `many`…). */
function pluralCategory(n: number, locale: string): string {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules.select(n);
}

const parsed = new Map<string, Node[]>();

function parse(template: string): Node[] {
  const cached = parsed.get(template);
  if (cached) return cached;
  let i = 0;
  const fail = (why: string): never => {
    throw new Error(`Bad message template (${why}) at ${i}: ${template}`);
  };
  const nodes = (inOption: boolean): Node[] => {
    const out: Node[] = [];
    let text = "";
    const flush = () => {
      if (text) out.push(text);
      text = "";
    };
    while (i < template.length) {
      const ch = template[i] as string;
      if (ch === "}") {
        if (!inOption) fail("unmatched }");
        break;
      }
      if (ch === "#" && inOption) {
        flush();
        out.push({ hash: true });
        i++;
        continue;
      }
      if (ch !== "{") {
        text += ch;
        i++;
        continue;
      }
      flush();
      i++;
      const head = readUntil([",", "}"]);
      const arg = head.trim();
      if (template[i] === "}") {
        i++;
        out.push({ arg, kind: "value", style: null });
        continue;
      }
      i++; // ,
      const kind = readUntil([",", "}"]).trim();
      if (kind === "list") {
        let style: string | null = null;
        if (template[i] === ",") {
          i++;
          style = readUntil(["}"]).trim();
        }
        i++;
        out.push({ arg, kind: "list", style });
        continue;
      }
      if (kind !== "plural" && kind !== "select") fail(`unknown kind '${kind}'`);
      i++; // ,
      const options: Record<string, Node[]> = {};
      for (;;) {
        while (template[i] === " ") i++;
        if (template[i] === "}") break;
        const key = readUntil(["{"]).trim();
        i++;
        options[key] = nodes(true);
        if (template[i] !== "}") fail("unclosed option");
        i++;
      }
      i++;
      if (!("other" in options)) fail("no 'other' option");
      out.push({ arg, kind: kind as "plural" | "select", options });
    }
    flush();
    return out;
  };
  const readUntil = (stops: string[]): string => {
    const start = i;
    while (i < template.length && !stops.includes(template[i] as string)) i++;
    if (i >= template.length) fail("unclosed {");
    return template.slice(start, i);
  };
  const result = nodes(false);
  parsed.set(template, result);
  return result;
}

/**
 * Render `template` with `params`; nested messages use `catalog`. `strict` (the engine's own
 * messages) throws on a missing parameter instead of leaving `{name}`.
 */
export function formatMessage(
  template: string,
  params: Readonly<Record<string, MessageParam>>,
  catalog: MessageCatalog = MESSAGES_EN,
  strict = false,
  { locale = "en" }: RenderOptions = {},
): string {
  const joiner = (style: string | null): string =>
    catalog[`list.${style ?? "comma"}`] ??
    (MESSAGES_EN as MessageCatalog)[`list.${style ?? "comma"}`] ??
    ", ";
  const value = (arg: string): MessageParam | undefined => {
    const v = params[arg];
    if (v === undefined && strict)
      throw new Error(`Message parameter '${arg}' missing: ${template}`);
    return v;
  };
  const show = (v: MessageParam, by = joiner(null)): string => {
    if (Array.isArray(v)) return v.map((x) => show(x)).join(by);
    if (typeof v === "object") return renderMessage(v as Message, catalog, { locale });
    return String(v);
  };
  const run = (nodes: readonly Node[], n: number | null): string =>
    nodes
      .map((node) => {
        if (typeof node === "string") return node;
        if ("hash" in node) return n === null ? "#" : String(n);
        const v = value(node.arg);
        if (v === undefined) return `{${node.arg}}`;
        if (!("options" in node)) {
          return show(v, node.kind === "list" ? joiner(node.style) : joiner(null));
        }
        if (node.kind === "plural") {
          const count = Number(v);
          const option =
            node.options[`=${count}`] ??
            node.options[pluralCategory(count, locale)] ??
            node.options.other;
          return run(option as Node[], count);
        }
        const option = node.options[String(v)] ?? node.options.other;
        return run(option as Node[], n);
      })
      .join("");
  return run(parse(template), null);
}

/**
 * A message in another catalog (an app's translation, rendered with its `locale`'s plural rules);
 * its `text` when the code isn't there.
 */
export function renderMessage(
  message: Message,
  catalog: MessageCatalog = MESSAGES_EN,
  options: RenderOptions = {},
): string {
  const template = catalog[message.code];
  return template === undefined
    ? message.text
    : formatMessage(template, message.params, catalog, false, options);
}

/** An engine message: its English text rendered from `MESSAGES_EN`. */
export function message(
  code: MessageCode,
  params: Readonly<Record<string, MessageParam>> = {},
): Message {
  return {
    code,
    params,
    text: checked(formatMessage(MESSAGES_EN[code], params, MESSAGES_EN, true)),
  };
}

/** The English texts of messages (a result's `notes`). */
export function texts(messages: readonly Message[]): string[] {
  return messages.map((m) => m.text);
}

/**
 * A rule refusing a roll or an option (no such attack, no slot of that level): a `RangeError`
 * whose `detail` is the reason as a message.
 */
export class RuleError extends RangeError {
  override name = "RuleError";
  readonly detail: Message;
  constructor(detail: Message) {
    super(detail.text);
    this.detail = detail;
  }
}

/** A `RangeError`'s reason as a message: a `RuleError`'s `detail`, else a `text` message. */
export function ruleReason(error: RangeError): Message {
  return error instanceof RuleError ? error.detail : plainMessage(error.message);
}

/** A message as is; a plain string as a `text` message. */
export function toMessage(m: Message | string): Message {
  return typeof m === "string" ? plainMessage(m) : m;
}

/** A sentence not given a code yet (or free text from the content): code `text`. */
export function plainMessage(text: string): Message {
  return { code: "text", params: { text }, text: checked(text) };
}

/** A message object pasted into a string by mistake shows up here, not in a UI. */
function checked(text: string): string {
  if (text.includes("[object Object]")) throw new Error(`A message was put in a string: ${text}`);
  return text;
}
