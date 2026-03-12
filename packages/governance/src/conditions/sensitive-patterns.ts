/**
 * Built-in regex patterns for detecting sensitive data in outputs.
 * Used by the sensitive_data_filter condition.
 */

export interface SensitivePattern {
  id: string;
  name: string;
  pattern: RegExp;
}

export const SENSITIVE_PATTERNS: SensitivePattern[] = [
  { id: "aws_key", name: "AWS Access Key", pattern: /AKIA[0-9A-Z]{16}/ },
  { id: "aws_secret", name: "AWS Secret Key", pattern: /[0-9a-zA-Z/+]{40}(?=\s|$|"|')/ },
  { id: "github_pat", name: "GitHub PAT", pattern: /ghp_[0-9a-zA-Z]{36}/ },
  { id: "github_oauth", name: "GitHub OAuth", pattern: /gho_[0-9a-zA-Z]{36}/ },
  { id: "github_app", name: "GitHub App Token", pattern: /ghs_[0-9a-zA-Z]{36}/ },
  { id: "generic_sk", name: "Secret Key (sk-)", pattern: /sk-[0-9a-zA-Z]{20,}/ },
  { id: "generic_pk", name: "Public Key (pk-)", pattern: /pk-[0-9a-zA-Z]{20,}/ },
  { id: "jwt", name: "JWT", pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { id: "private_key", name: "Private Key", pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/ },
  { id: "postgres_uri", name: "PostgreSQL URI", pattern: /postgres(?:ql)?:\/\/[^\s]+/ },
  { id: "mysql_uri", name: "MySQL URI", pattern: /mysql:\/\/[^\s]+/ },
  { id: "mongodb_uri", name: "MongoDB URI", pattern: /mongodb(?:\+srv)?:\/\/[^\s]+/ },
  { id: "redis_uri", name: "Redis URI", pattern: /redis(?:s)?:\/\/[^\s]+/ },
  { id: "slack_token", name: "Slack Token", pattern: /xox[bpras]-[0-9a-zA-Z-]+/ },
  { id: "stripe_key", name: "Stripe Key", pattern: /sk_(?:live|test)_[0-9a-zA-Z]{24,}/ },
  { id: "sendgrid_key", name: "SendGrid Key", pattern: /SG\.[0-9a-zA-Z_-]{22}\.[0-9a-zA-Z_-]{43}/ },
];

/** Get patterns by ID list, or all if empty/undefined */
export function getSensitivePatterns(ids?: string[]): SensitivePattern[] {
  if (!ids || ids.length === 0) return SENSITIVE_PATTERNS;
  return SENSITIVE_PATTERNS.filter((p) => ids.includes(p.id));
}
