export function buildAuthenticatedHlsUrl(streamUrl: string, playlistPath: string): string {
  const stream = new URL(streamUrl);
  const token = stream.searchParams.get('token');
  if (!token) throw new Error('The local stream token is unavailable');

  const playlist = new URL(playlistPath, stream.origin);
  playlist.searchParams.set('token', token);
  return playlist.toString();
}
