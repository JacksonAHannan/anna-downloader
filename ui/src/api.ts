export async function readApiResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error(
      response.ok
        ? 'The local server returned the application page instead of API data. Restart the UI server and try again.'
        : `The local server returned an unexpected response (${response.status}).`
    );
  }

  return response.json() as Promise<T>;
}
