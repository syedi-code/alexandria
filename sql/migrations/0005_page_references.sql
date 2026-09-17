-- Add pdf_page_offset to books table for calculating PDF page from print page
-- Formula: pdf_page = print_page + pdf_page_offset
-- Example: if print page 1 is PDF page 15, offset is 14
ALTER TABLE books ADD COLUMN pdf_page_offset INTEGER DEFAULT 0;

-- Note: page references for notes/quotes are stored in the event_ledger payload JSON
-- as "page" (print page string, e.g., "42", "42-45", "xiv")
-- The PDF page is calculated at render time using: pdf_page = parse_page(page) + book.pdf_page_offset
