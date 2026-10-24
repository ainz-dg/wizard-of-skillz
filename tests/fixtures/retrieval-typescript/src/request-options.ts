export function createRequestOptions(token: string) {
  return { headers: { Authorization: 'Bearer ' + token } };
}
