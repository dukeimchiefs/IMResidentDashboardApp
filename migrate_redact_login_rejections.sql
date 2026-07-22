-- One-off, idempotent privacy migration for already-deployed databases.
-- Retains enough of a rejected address to spot a likely domain typo while
-- removing the full local part. New rows are masked before insertion in code.
UPDATE login_rejections
SET email = CASE
  WHEN instr(email, '@') >= 2
    THEN substr(email, 1, 1) || '***' || substr(email, instr(email, '@'))
  ELSE '***'
END
WHERE email <> '***'
  AND email NOT LIKE '_***@%';
