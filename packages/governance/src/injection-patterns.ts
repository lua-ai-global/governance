/**
 * Built-in prompt injection detection patterns.
 *
 * 64 patterns across 7 categories. Separated from the detection
 * engine to keep files under 300 LOC. Additional patterns are
 * in injection-patterns-ext.ts.
 */

import type { InjectionPattern } from "./injection-detect.js";
import { EXTENDED_PATTERNS } from "./injection-patterns-ext.js";

export const BUILTIN_PATTERNS: InjectionPattern[] = [
  // ─── Instruction Override ────────────────────────────────────────

  {
    id: "ignore_previous",
    category: "instruction_override",
    pattern: /\bignore\s+(?:(?:all|the)\s+)?(?:previous|prior|above|earlier|preceding|remaining|other)?\s*(?:instructions?|prompts?|rules?|guidelines?|directives?|commands?|context)\b/i,
    weight: 0.9,
    description: "Attempts to override previous instructions",
  },
  {
    id: "disregard_instructions",
    category: "instruction_override",
    pattern: /\bdisregard\s+(?:(?:all|the)\s+)?(?:previous|prior|above|your|the|my|any|system)\s+(?:previous\s+)?(?:instructions?|prompts?|rules?|guidelines?)\b/i,
    weight: 0.9,
    description: "Attempts to disregard instructions",
  },
  {
    id: "forget_everything",
    category: "instruction_override",
    pattern: /\bforget\s+(?:everything|all|what)\s+(?:you\s+)?(?:know|were told|learned|have been|said|mentioned)\b/i,
    weight: 0.85,
    description: "Attempts to reset agent memory/context",
  },
  {
    id: "new_instructions",
    category: "instruction_override",
    pattern: /\b(?:your\s+)?new\s+(?:instructions?|tasks?|directives?)\s*(?:are|is|:)/i,
    weight: 0.8,
    description: "Attempts to inject new instructions",
  },
  {
    id: "do_not_follow",
    category: "instruction_override",
    pattern: /\b(?:do\s+not|don't)\s+(?:follow|comply\s+with|obey|adhere\s+to)\s+(?:your|the|any|previous)?\s*(?:instructions?|rules?|guidelines?|programming|constraints?|restrictions?)\b/i,
    weight: 0.85,
    description: "Directly tells agent to not follow rules",
  },
  {
    id: "override_system",
    category: "instruction_override",
    pattern: /\b(?:override|bypass|circumvent|disable)\s+(?:your|the|all|any|my)?\s*(?:system|safety|security|content)?\s*(?:prompt|instructions?|filters?|rules?|restrictions?|policies?|everything)\b/i,
    weight: 0.95,
    description: "Explicit system override attempt",
  },
  {
    id: "instead_follow",
    category: "instruction_override",
    pattern: /\binstead\s+(?:follow|use|do|obey)\b/i,
    weight: 0.7,
    description: "Redirects agent to follow different instructions",
  },
  {
    id: "start_over",
    category: "instruction_override",
    pattern: /\b(?:start\s+over(?:\s+from\s+scratch)?(?!\s+with)|begin\s+again|restart)\b/i,
    weight: 0.65,
    description: "Attempts to reset conversation context",
  },
  {
    id: "reset_default",
    category: "instruction_override",
    pattern: /\breset\s+(?:to\s+)?(?:default|initial|factory)\b/i,
    weight: 0.65,
    description: "Attempts to reset to default state",
  },
  {
    id: "negative_directive",
    category: "instruction_override",
    pattern: /\b(?:do\s+not|don't|never)\s+(?:say|respond|reply|answer|tell|refuse|comply|follow)\s+.{1,50}?\binstead\b/i,
    weight: 0.75,
    description: "Negative directive with redirect",
  },
  {
    id: "suppress_warnings",
    category: "instruction_override",
    pattern: /\b(?:do\s+not|don't)\s+respond\s+with\s+(?:safety\s+)?(?:warnings?|filters?|checks?|restrictions?|limitations?)\b/i,
    weight: 0.8,
    description: "Attempts to suppress safety warnings",
  },
  {
    id: "never_refuse",
    category: "instruction_override",
    pattern: /\b(?:never\s+refuse|always\s+(?:answer|comply|obey|respond|follow))\b/i,
    weight: 0.85,
    description: "Demands unconditional compliance",
  },

  // ─── Role Manipulation ──────────────────────────────────────────

  {
    id: "you_are_now",
    category: "role_manipulation",
    pattern: /\b(?:you\s+are|you're)\s+(?:now\s+)?(?:a|an|the|my)\s+\w{3,}/i,
    weight: 0.7,
    description: "Attempts to redefine agent's role",
  },
  {
    id: "act_as",
    category: "role_manipulation",
    pattern: /\b(?:act|behave|respond|pretend|roleplay)\s+(?:as|like)\s+(?:a|an|the|if\s+you\s+(?:are|were))?\s*/i,
    weight: 0.6,
    description: "Role-playing injection attempt",
  },
  {
    id: "jailbreak_dan",
    category: "role_manipulation",
    pattern: /\b(?:DAN|do\s+anything\s+now|developer\s+mode|jailbreak|god\s+mode|sudo\s+mode|unrestricted|unfiltered|uncensored)\s*(?:mode|version)?\b/i,
    weight: 0.95,
    description: "Known jailbreak pattern (DAN/developer mode)",
  },
  {
    id: "pretend_no_restrictions",
    category: "role_manipulation",
    pattern: /\bpretend\s+(?:you\s+)?(?:have\s+)?(?:no|without)\s+(?:restrictions?|limitations?|rules?|filters?|boundaries)\b/i,
    weight: 0.9,
    description: "Asks agent to pretend it has no restrictions",
  },
  {
    id: "from_now_on",
    category: "role_manipulation",
    pattern: /\bfrom\s+now\s+on,?\s+you\s+(?:are|will\s+be)\b/i,
    weight: 0.75,
    description: "Redefines agent role with temporal framing",
  },
  {
    id: "simulate_being",
    category: "role_manipulation",
    pattern: /\bsimulate\s+(?:being|that\s+you\s+are)\b/i,
    weight: 0.7,
    description: "Simulation-based role manipulation",
  },
  {
    id: "new_role",
    category: "role_manipulation",
    pattern: /\b(?:your\s+new\s+role\s+is|assume\s+the\s+role\s+of)\b/i,
    weight: 0.8,
    description: "Explicit role reassignment",
  },
  {
    id: "enable_mode",
    category: "role_manipulation",
    pattern: /\b(?:enable|activate|turn\s+on|switch\s+to)\s+(?:developer|dev|test|debug|admin|god)\s+mode\b/i,
    weight: 0.9,
    description: "Attempts to enable a privileged mode",
  },
  {
    id: "hypothetical_framing",
    category: "role_manipulation",
    pattern: /\b(?:hypothetically|theoretically)\s+speaking[,\s]+(?:if|what|how)/i,
    weight: 0.5,
    description: "Hypothetical framing to bypass restrictions",
  },
  {
    id: "just_a_test",
    category: "role_manipulation",
    pattern: /\bthis\s+is\s+(?:just\s+)?(?:a\s+)?(?:test|simulation|game|exercise|scenario)\b/i,
    weight: 0.45,
    description: "Framing as test/simulation to lower guard",
  },
  {
    id: "educational_excuse",
    category: "role_manipulation",
    pattern: /\bfor\s+(?:educational|research|testing|academic|scientific)\s+purposes\s+only\b/i,
    weight: 0.5,
    description: "Educational/research purpose excuse",
  },
  {
    id: "imagine_suppose",
    category: "role_manipulation",
    pattern: /\b(?:imagine|suppose)\s+(?:if|that|you|for\s+a\s+moment)\b/i,
    weight: 0.4,
    description: "Hypothetical scenario framing",
  },
  {
    id: "temporal_exploit",
    category: "role_manipulation",
    pattern: /\b(?:legal|allowed|permitted|acceptable)\s+now\b|\bnow\s+(?:legal|allowed|permitted)\b/i,
    weight: 0.6,
    description: "Claims rules have changed to permit action",
  },

  // ─── Context Escape / Prompt Leak ──────────────────────────────

  {
    id: "system_prompt_leak",
    category: "context_escape",
    pattern: /\b(?:reveal|show|display|output|repeat|print|tell\s+me)\s+(?:me\s+)?(?:the\s+)?(?:your\s+)?(?:system\s+)?(?:prompt|instructions?|initial\s+prompt|hidden\s+prompt|original\s+instructions?)\b/i,
    weight: 0.85,
    description: "Attempts to extract system prompt",
  },
  {
    id: "what_are_instructions",
    category: "context_escape",
    pattern: /\bwhat\s+(?:were|are|is)\s+(?:your|the)\s+(?:original\s+)?(?:instructions|guidelines|rules|directives|prompt)\b/i,
    weight: 0.8,
    description: "Questions about original instructions",
  },
  {
    id: "how_configured",
    category: "context_escape",
    pattern: /\bhow\s+were\s+you\s+(?:configured|programmed|instructed|set\s+up|trained)\b/i,
    weight: 0.75,
    description: "Questions about agent configuration",
  },
  {
    id: "not_allowed_to",
    category: "context_escape",
    pattern: /\bwhat\s+(?:are|were)\s+you\s+(?:not\s+)?(?:allowed|forbidden|prohibited|told)\s+to\s+(?:do|say)\b/i,
    weight: 0.7,
    description: "Probing agent restrictions",
  },
  {
    id: "markdown_injection",
    category: "context_escape",
    pattern: /!\[.*?\]\((?:https?:\/\/|data:).*?\)/i,
    weight: 0.6,
    description: "Markdown image injection (potential data exfiltration)",
  },
  {
    id: "delimiter_escape",
    category: "context_escape",
    pattern: /(?:<\/?(?:system|user|assistant|human|ai|context|instruction|prompt)>|\[\/?\s*(?:system|user|assistant|human|ai|context|instruction|prompt)\s*\]|#{2,}\s*(?:system|admin|root|user|assistant|instruction|prompt)\s*#{2,}|<\|(?:im_start|im_end|endoftext)\|>|\[INST\]|\[\/INST\]|<s>|<\/s>)/i,
    weight: 0.8,
    description: "Model delimiters or structured markers to escape context",
  },
  {
    id: "fence_prompt",
    category: "context_escape",
    pattern: /\b(?:fence|format|wrap|enclose|put)\s+(?:the\s+)?(?:above\s+)?(?:prompt|instructions|content|text)\s+(?:in|inside|within)\s+(?:a\s+)?(?:markdown|code|text|raw)\s*(?:block|fence)?\b/i,
    weight: 0.75,
    description: "Attempts to extract prompt via formatting",
  },
  {
    id: "retranscribe",
    category: "context_escape",
    pattern: /\b(?:re-?transcript|re-?transcribe|copy|reproduce|replicate|duplicate)\s+(?:the\s+)?(?:above|previous|prior)\s+(?:content|text|prompt|instructions|message|conversation)\b/i,
    weight: 0.8,
    description: "Attempts to reproduce system content",
  },
  {
    id: "conversation_history",
    category: "context_escape",
    pattern: /\b(?:show|display|repeat|print)\s+(?:me\s+)?(?:the\s+)?(?:full\s+)?(?:conversation|chat|message|dialogue|earlier)\s+(?:history|log|record|transcript|messages)\b/i,
    weight: 0.7,
    description: "Attempts to access conversation history",
  },
  {
    id: "previous_user_data",
    category: "context_escape",
    pattern: /\bwhat\s+did\s+(?:the\s+)?(?:last|previous|prior|other|earlier)\s+(?:users?|persons?|people)\s+(?:ask|say|tell|request|want)\b/i,
    weight: 0.8,
    description: "Attempts to access other users' data",
  },

  // ─── Data Exfiltration ──────────────────────────────────────────

  {
    id: "exfil_url",
    category: "data_exfiltration",
    pattern: /\b(?:send|post|transmit|upload|fetch|request)\s+(?:(?:all|every)\s+)?(?:(?:this|the|my|our|your)\s+)?(?:data|information|conversation|messages?|context|history|content)\s+(?:to|at|via)\s+/i,
    weight: 0.85,
    description: "Attempts to exfiltrate data to external URL",
  },
  {
    id: "encode_and_send",
    category: "data_exfiltration",
    pattern: /\b(?:base64|encode|encrypt|hex)\s+(?:the|this|all|your)\s+(?:data|response|conversation|system\s+prompt)\b/i,
    weight: 0.75,
    description: "Encoding data for exfiltration",
  },
  {
    id: "reveal_secrets",
    category: "data_exfiltration",
    pattern: /\b(?:output|list|show|print|display|reveal|dump|expose|extract|give\s+me|return|write\s+out)\s+(?:all|every)\s+(?:the\s+)?(?:stored\s+|available\s+|system\s+)?(?:environment\s+variables?|env\s+vars?|api\s+keys?|credentials?|secrets?|passwords?|tokens?|private\s+keys?|access\s+keys?|service\s+accounts?|connection\s+strings?|auth\s+tokens?|bearer\s+tokens?|ssh\s+keys?|gpg\s+keys?|signing\s+keys?|encryption\s+keys?|database\s+(?:passwords?|credentials?))\b/i,
    weight: 0.85,
    description: "Attempts to extract secrets, keys, or credentials",
  },
  {
    id: "dump_secrets",
    category: "data_exfiltration",
    pattern: /\b(?:dump|expose|extract|exfiltrate|leak|steal|harvest)\s+(?:the\s+)?(?:all\s+)?(?:environment\s+variables?|env\s+vars?|api\s+keys?|credentials?|secrets?|passwords?|tokens?|private\s+keys?|access\s+keys?|ssh\s+keys?)\b/i,
    weight: 0.9,
    description: "Explicit secret dumping/exfiltration verbs",
  },
  {
    id: "exfil_config",
    category: "data_exfiltration",
    pattern: /\b(?:output|show|print|display|reveal|dump|cat)\s+(?:the\s+)?(?:contents?\s+(?:of\s+)?)?(?:~\/|\.\/|\/)?(?:\.env\b|\.envrc\b|\.env\.local\b|\.aws\/|\.ssh\/|\/etc\/(?:passwd|shadow)|\.git\/config|\.npmrc|\.pypirc|kubeconfig)\b/i,
    weight: 0.9,
    description: "Attempts to read sensitive config files",
  },

  // ─── Encoding Attacks ───────────────────────────────────────────

  {
    id: "base64_payload",
    category: "encoding_attack",
    pattern: /\b(?:decode|execute|run|eval)[\s\w]*?(?:base64|b64|encoded|:)\s*[A-Za-z0-9+/]{16,}={0,2}/i,
    weight: 0.8,
    description: "Base64-encoded payload injection",
  },
  {
    id: "base64_execute",
    category: "encoding_attack",
    pattern: /\b(?:decode|execute|run|eval)[\s\w]{0,20}:\s*[A-Za-z0-9+/]{16,}={0,2}\s*$/im,
    weight: 0.85,
    description: "Instruction to decode/execute an encoded payload",
  },
  {
    id: "obfuscation_decode",
    category: "encoding_attack",
    pattern: /\b(?:decode|decrypt|decipher|translate\s+from)\s+(?:this\s+|the\s+)?(?:base64|base-64|b64|hex|hexadecimal|rot13|rot-13|binary|unicode|morse)\s+(?:(?:to\s+text\s+)?(?:and\s+)?)?(?:execute|follow|run|do|perform|obey)?/i,
    weight: 0.75,
    description: "Instruction to decode obfuscated content",
  },
  {
    id: "spell_backward",
    category: "encoding_attack",
    pattern: /\bspell(?:ed)?\s+(?:(?:it|this|that)\s+)?(?:backwards?|in\s+reverse)\s+(?:and\s+)?(?:execute|run|follow|do|perform|obey)\b/i,
    weight: 0.8,
    description: "Reverse-spelling obfuscation attack",
  },
  {
    id: "unscramble",
    category: "encoding_attack",
    pattern: /\b(?:unscramble|rearrange|reorder)\s+(?:these\s+|the\s+)?(?:letters?|words?|characters?)\s+(?:and\s+)?(?:execute|follow|run|do|perform|obey)\b/i,
    weight: 0.8,
    description: "Unscramble-and-execute obfuscation",
  },
  {
    id: "unicode_homoglyph",
    category: "encoding_attack",
    pattern: /[\u0400-\u04FF\u0500-\u052F].*(?:ignore|override|system|admin)/i,
    weight: 0.7,
    description: "Unicode homoglyph attack (Cyrillic characters masking Latin)",
  },
  {
    id: "raw_base64_blob",
    category: "encoding_attack",
    pattern: /[A-Za-z0-9+/]{40,}={0,2}/,
    weight: 0.45,
    description: "Suspicious base64-encoded blob",
  },
  {
    id: "hex_escape_seq",
    category: "encoding_attack",
    pattern: /(?:\\x[0-9A-Fa-f]{2}){5,}/,
    weight: 0.7,
    description: "Hex escape sequence chain",
  },
  {
    id: "unicode_escape_seq",
    category: "encoding_attack",
    pattern: /(?:\\u[0-9A-Fa-f]{4}){5,}/,
    weight: 0.7,
    description: "Unicode escape sequence chain",
  },
  {
    id: "html_entity_seq",
    category: "encoding_attack",
    pattern: /(?:&#{1,2}[xX]?[0-9A-Fa-f]+;){5,}/,
    weight: 0.7,
    description: "HTML entity encoding chain",
  },
  {
    id: "url_encoded_seq",
    category: "encoding_attack",
    pattern: /(?:%[0-9A-Fa-f]{2}){5,}/,
    weight: 0.65,
    description: "URL-encoded character chain",
  },
  {
    id: "null_bytes",
    category: "encoding_attack",
    pattern: /\x00+/,
    weight: 0.8,
    description: "Null byte injection",
  },

  // ─── Social Engineering ─────────────────────────────────────────

  {
    id: "urgency_pressure",
    category: "social_engineering",
    pattern: /(?:this\s+is\s+(?:an?\s+)?(?:emergency|urgent|critical)|(?:lives?|people)\s+(?:are|will\s+be)\s+(?:at\s+)?(?:risk|danger|stake)|you\s+must\s+(?:immediately|urgently|now))\s+/i,
    weight: 0.5,
    description: "Urgency-based social engineering",
  },
  {
    id: "authority_claim",
    category: "social_engineering",
    pattern: /\b(?:i\s+am\s+(?:your|the|an?)\s+(?:admin|administrator|developer|creator|owner|supervisor|manager|CEO)|(?:as\s+(?:your|the)\s+(?:admin|developer|creator)))\b/i,
    weight: 0.65,
    description: "False authority claim",
  },
  {
    id: "testing_excuse",
    category: "social_engineering",
    pattern: /(?:this\s+is\s+(?:just\s+)?(?:a\s+)?test|(?:i'm|i\s+am)\s+(?:just\s+)?testing|for\s+(?:testing|debugging|research)\s+purposes?\s+(?:only|please))/i,
    weight: 0.4,
    description: "Testing excuse to bypass restrictions",
  },

  // ─── Extended patterns (obfuscation, etc.) ──────────────────────
  ...EXTENDED_PATTERNS,
];
