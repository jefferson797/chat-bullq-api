/**
 * Nome de exibição do contato, em ordem de preferência:
 * 1. firstName + lastName (cadastro manual — mais confiável)
 * 2. name (nome do perfil do WhatsApp)
 * 3. phone / fallback
 *
 * Espelha o helper do web em src/lib/contact-display.ts.
 */
export interface ContactDisplayParts {
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  phone?: string | null;
}

export function contactDisplayName(
  c: ContactDisplayParts | null | undefined,
  fallback = 'Cliente',
): string {
  if (!c) return fallback;
  const fullName = [c.firstName, c.lastName]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(' ');
  return fullName || c.name?.trim() || c.phone || fallback;
}

/** Nome + empresa: "Maria Silva · Exatek". Sem empresa, só o nome. */
export function contactDisplayTitle(
  c: ContactDisplayParts | null | undefined,
  fallback = 'Cliente',
): string {
  const name = contactDisplayName(c, fallback);
  const company = c?.company?.trim();
  return company ? `${name} · ${company}` : name;
}
