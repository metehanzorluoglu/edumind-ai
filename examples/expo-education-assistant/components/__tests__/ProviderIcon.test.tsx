import { create } from 'react-test-renderer';
import {
  FacebookIcon,
  GenericProviderIcon,
  GoogleIcon,
  LinkedInIcon,
  providerIcon,
} from '../ProviderIcon';

describe('ProviderIcon', () => {
  it('renders GoogleIcon without throwing', () => {
    expect(() => create(<GoogleIcon />)).not.toThrow();
  });

  it('renders FacebookIcon without throwing', () => {
    expect(() => create(<FacebookIcon />)).not.toThrow();
  });

  it('renders LinkedInIcon without throwing', () => {
    expect(() => create(<LinkedInIcon />)).not.toThrow();
  });

  it('renders GenericProviderIcon without throwing', () => {
    expect(() => create(<GenericProviderIcon />)).not.toThrow();
  });

  // Inspects the returned React element's own `type` directly rather than
  // rendering through react-test-renderer and diffing output — this repo's
  // jest environment has no native-module mock for react-native-svg, so an
  // <Svg> subtree renders as empty/null here regardless of which icon it
  // is; comparing element types is a robust way to verify the *mapping* is
  // correct without depending on that render output at all.
  it('providerIcon maps each known provider slug to its own dedicated component', () => {
    expect(providerIcon('google').type).toBe(GoogleIcon);
    expect(providerIcon('facebook').type).toBe(FacebookIcon);
    expect(providerIcon('linkedin').type).toBe(LinkedInIcon);
  });

  it('providerIcon falls back to the generic icon for an unknown provider', () => {
    expect(providerIcon('some-future-provider').type).toBe(GenericProviderIcon);
  });
});
