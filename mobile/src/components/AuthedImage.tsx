/** An image the server serves behind sign-in (native: Image sends the token as a header). */
import { Image, type ImageStyle, type StyleProp } from 'react-native';

import { authedSource } from '@/api/client';

export function AuthedImage({ path, style, label }: { path: string; style?: StyleProp<ImageStyle>; label?: string }) {
  return <Image source={authedSource(path)} style={style} resizeMode="contain" accessibilityLabel={label} />;
}
