// The query string arrives as a string, an array, or nothing. Only a trimmed string is searched.
export function queryOf(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}
