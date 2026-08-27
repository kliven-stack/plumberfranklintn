import { neon } from '@neondatabase/serverless';
import { env } from './env';

export interface Submission {
  name: string | null;
  email: string;
  phone: string;
  customerType: string;
  emergency: string;
  message: string | null;
  pagePath: string | null;
  userAgent: string | null;
  ipHash: string | null;
}

/**
 * Store one submission. Neon is the source of truth, so this runs **before** the
 * e-mails and a failure here fails the whole request (playbook §4c step 5): a lead
 * that was never written is one nobody can recover, whereas an e-mail that never
 * sent still has a row behind it.
 *
 * Returns the new row's id.
 */
export async function storeSubmission(input: Submission): Promise<number> {
  const url = env.databaseUrl;
  if (!url) throw new Error('DATABASE_URL is not set — connect the Neon integration (playbook §5.1)');

  const sql = neon(url);
  const rows = await sql`
    insert into submissions
      (name, email, phone, customer_type, emergency, message, page_path, user_agent, ip_hash)
    values
      (${input.name}, ${input.email}, ${input.phone}, ${input.customerType}, ${input.emergency},
       ${input.message}, ${input.pagePath}, ${input.userAgent}, ${input.ipHash})
    returning id
  `;
  return Number((rows[0] as { id: number | string }).id);
}
