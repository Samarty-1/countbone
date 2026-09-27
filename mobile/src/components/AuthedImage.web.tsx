/**
 * An image the server serves behind sign-in (web preview).
 *
 * A browser <img> cannot send an Authorization header, so the image is
 * fetched with the token and shown from a blob URL.
 */
import { useEffect, useState } from 'react';
import { Image, View, type ImageStyle, type StyleProp } from 'react-native';

import { authHeaders, getServer } from '@/api/client';

export function AuthedImage({ path, style, label }: { path: string; style?: StyleProp<ImageStyle>; label?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    fetch(`${getServer()}${path}`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (!alive || !b) return;
        objectUrl = URL.createObjectURL(b);
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);
  if (!url) return <View style={style as object} />;
  return <Image source={{ uri: url }} style={style} resizeMode="contain" accessibilityLabel={label} />;
}
