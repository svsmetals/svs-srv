// FY-based offer number allocation. Numbers restart at 1 each financial year,
// so the next free number is tracked per FY in the quote_sequences table.
// Allocation must be race-safe: two execs saving at once must get distinct
// numbers. We lock the FY row FOR UPDATE inside the caller's transaction.
//
// Call with the transaction client (from withTransaction) so the lock is held
// for the duration of the quote insert.
export async function allocateQuoteNumber(client, fy) {
  const { rows } = await client.query(
    'select next_no from quote_sequences where fy = $1 for update',
    [fy]
  );
  if (rows.length === 0) {
    // First offer of this financial year.
    await client.query(
      'insert into quote_sequences (fy, next_no) values ($1, $2)',
      [fy, 2]
    );
    return 1;
  }
  const no = rows[0].next_no;
  await client.query(
    'update quote_sequences set next_no = next_no + 1 where fy = $1',
    [fy]
  );
  return no;
}

export function quoteLabel(no, fy) {
  return `${no}/${fy}`;
}
