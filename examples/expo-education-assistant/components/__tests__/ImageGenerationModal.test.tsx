import { RequestCancelledError } from 'education-assistant-client';
import { Animated } from 'react-native';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { ImageGenerationModal } from '../ImageGenerationModal';

// The modal reads the client (to refetch Regenerate references) and opens the
// image picker, and encodes picked/remote bytes — all mocked here so the modal
// is exercised without a real provider, picker, or FileReader/expo-file-system.
// readPickerAssetAsDataUrl/resolveRemoteReference are overridden (the pure
// validators are kept real via requireActual).
const mockClient = { fetchAttachmentBlob: jest.fn() };
jest.mock('@/lib/ClientProvider', () => ({
  useClient: () => ({ client: mockClient }),
}));

const mockRequestPermissions = jest.fn();
const mockLaunchImageLibraryAsync = jest.fn();
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: (...args: unknown[]) => mockRequestPermissions(...args),
  launchImageLibraryAsync: (...args: unknown[]) => mockLaunchImageLibraryAsync(...args),
}));

const mockReadPicker = jest.fn();
const mockResolveRemote = jest.fn();
jest.mock('@/lib/referenceImages', () => {
  const actual = jest.requireActual('@/lib/referenceImages');
  return {
    ...actual,
    readPickerAssetAsDataUrl: (...args: unknown[]) => mockReadPicker(...args),
    resolveRemoteReference: (...args: unknown[]) => mockResolveRemote(...args),
  };
});

function findByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.find((node) => node.props.accessibilityLabel === label);
}

function queryByText(root: ReactTestInstance, text: string): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => String(node.type) === 'Text' && node.children.includes(text)
  );
  return matches[0] ?? null;
}

function textMatching(root: ReactTestInstance, pattern: RegExp): ReactTestInstance[] {
  return root.findAll(
    (node) =>
      String(node.type) === 'Text' &&
      typeof node.children[0] === 'string' &&
      pattern.test(node.children[0])
  );
}

describe('ImageGenerationModal', () => {
  it('calls onGenerate with the trimmed prompt, default square aspect ratio, and 1 image, then closes', async () => {
    const onGenerate = jest.fn().mockResolvedValue(undefined);
    const onClose = jest.fn();
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<ImageGenerationModal visible onClose={onClose} onGenerate={onGenerate} />);
    });

    await act(async () => {
      findByLabel(renderer.root, 'Image prompt').props.onChangeText('  a red apple  ');
    });
    await act(async () => {
      findByLabel(renderer.root, 'Generate').props.onPress();
      await Promise.resolve();
    });

    expect(onGenerate).toHaveBeenCalledWith(
      {
        prompt: 'a red apple',
        negativePrompt: null,
        width: 512,
        height: 512,
        numImages: 1,
        referenceImages: [],
      },
      expect.objectContaining({ signal: expect.any(AbortSignal), onProgress: expect.any(Function) })
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('maps the selected aspect ratio chip to the correct width/height', async () => {
    const onGenerate = jest.fn().mockResolvedValue(undefined);
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <ImageGenerationModal visible onClose={() => {}} onGenerate={onGenerate} />
      );
    });

    await act(async () => {
      findByLabel(renderer.root, 'Image prompt').props.onChangeText('a mountain');
    });
    await act(async () => {
      findByLabel(renderer.root, 'Widescreen (16:9)').props.onPress();
    });
    await act(async () => {
      findByLabel(renderer.root, 'Generate').props.onPress();
      await Promise.resolve();
    });

    expect(onGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ width: 768, height: 432 }),
      expect.anything()
    );
  });

  it('includes a trimmed negative prompt when provided, and null when left blank', async () => {
    const onGenerate = jest.fn().mockResolvedValue(undefined);
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <ImageGenerationModal visible onClose={() => {}} onGenerate={onGenerate} />
      );
    });

    await act(async () => {
      findByLabel(renderer.root, 'Image prompt').props.onChangeText('a cat');
      findByLabel(renderer.root, 'Negative prompt').props.onChangeText('  blurry  ');
    });
    await act(async () => {
      findByLabel(renderer.root, 'Generate').props.onPress();
      await Promise.resolve();
    });

    expect(onGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ negativePrompt: 'blurry' }),
      expect.anything()
    );
  });

  it('increments and decrements the number-of-images stepper within its bounds', async () => {
    const onGenerate = jest.fn().mockResolvedValue(undefined);
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <ImageGenerationModal visible onClose={() => {}} onGenerate={onGenerate} />
      );
    });

    await act(async () => {
      findByLabel(renderer.root, 'Fewer images').props.onPress();
    });
    expect(queryByText(renderer.root, '1')).toBeTruthy(); // clamped at the floor of 1

    await act(async () => {
      findByLabel(renderer.root, 'More images').props.onPress();
      findByLabel(renderer.root, 'More images').props.onPress();
    });
    expect(queryByText(renderer.root, '3')).toBeTruthy();

    await act(async () => {
      findByLabel(renderer.root, 'Image prompt').props.onChangeText('a cat');
    });
    await act(async () => {
      findByLabel(renderer.root, 'Generate').props.onPress();
      await Promise.resolve();
    });
    expect(onGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ numImages: 3 }),
      expect.anything()
    );
  });

  it('shows the backend error message inline and does not close when onGenerate rejects', async () => {
    const onGenerate = jest
      .fn()
      .mockRejectedValue(new Error("Model 'x/flux2-klein' is not installed."));
    const onClose = jest.fn();
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<ImageGenerationModal visible onClose={onClose} onGenerate={onGenerate} />);
    });

    await act(async () => {
      findByLabel(renderer.root, 'Image prompt').props.onChangeText('a cat');
    });
    await act(async () => {
      findByLabel(renderer.root, 'Generate').props.onPress();
      await Promise.resolve();
    });

    expect(queryByText(renderer.root, "Model 'x/flux2-klein' is not installed.")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not call onGenerate for a blank/whitespace-only prompt', async () => {
    const onGenerate = jest.fn();
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <ImageGenerationModal visible onClose={() => {}} onGenerate={onGenerate} />
      );
    });

    await act(async () => {
      findByLabel(renderer.root, 'Image prompt').props.onChangeText('   ');
    });
    await act(async () => {
      findByLabel(renderer.root, 'Generate').props.onPress();
      await Promise.resolve();
    });

    expect(onGenerate).not.toHaveBeenCalled();
  });

  it('prefills the form from initialValues (Regenerate)', async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <ImageGenerationModal
          visible
          onClose={() => {}}
          onGenerate={jest.fn().mockResolvedValue(undefined)}
          initialValues={{
            prompt: 'a red apple',
            negativePrompt: 'blurry',
            width: 768,
            height: 576,
            numImages: 2,
          }}
        />
      );
    });

    expect(findByLabel(renderer.root, 'Image prompt').props.value).toBe('a red apple');
    expect(findByLabel(renderer.root, 'Negative prompt').props.value).toBe('blurry');
    expect(findByLabel(renderer.root, 'Landscape (4:3)').props.accessibilityState.checked).toBe(
      true
    );
    expect(queryByText(renderer.root, '2')).toBeTruthy();
  });

  describe('progress display', () => {
    it('shows real sequential progress ("Generating image N of total") and a determinate bar for multiple images — never a faked fraction', async () => {
      let capturedOnProgress!: (completed: number, total: number) => void;
      const onGenerate = jest.fn(
        (_params, context: { onProgress: (completed: number, total: number) => void }) => {
          capturedOnProgress = context.onProgress;
          return new Promise<void>(() => {}); // never resolves within this test
        }
      );
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          <ImageGenerationModal visible onClose={() => {}} onGenerate={onGenerate} />
        );
      });

      await act(async () => {
        findByLabel(renderer.root, 'Image prompt').props.onChangeText('a cat');
        findByLabel(renderer.root, 'More images').props.onPress(); // 2
        findByLabel(renderer.root, 'More images').props.onPress(); // 3
      });
      await act(async () => {
        findByLabel(renderer.root, 'Generate').props.onPress();
        await Promise.resolve();
      });

      expect(queryByText(renderer.root, 'Generating image 1 of 3')).toBeTruthy();

      await act(async () => {
        capturedOnProgress(1, 3);
      });
      expect(queryByText(renderer.root, 'Generating image 2 of 3')).toBeTruthy();

      await act(async () => {
        capturedOnProgress(2, 3);
      });
      expect(queryByText(renderer.root, 'Generating image 3 of 3')).toBeTruthy();
      // Never the single-image indeterminate copy.
      expect(queryByText(renderer.root, 'Generating image… 0s')).toBeNull();

      // onGenerate's Promise never resolves in this test — unmount so its
      // elapsed-time useEffect's setInterval doesn't keep firing (a real
      // timer) after the test itself has finished.
      await act(async () => {
        renderer.unmount();
      });
    });

    it('shows an indeterminate bar and a ticking elapsed-seconds counter for a single image', async () => {
      jest.useFakeTimers();
      try {
        const onGenerate = jest.fn(() => new Promise<void>(() => {}));
        let renderer!: ReturnType<typeof create>;
        await act(async () => {
          renderer = create(
            <ImageGenerationModal visible onClose={() => {}} onGenerate={onGenerate} />
          );
        });

        await act(async () => {
          findByLabel(renderer.root, 'Image prompt').props.onChangeText('a cat');
        });
        await act(async () => {
          findByLabel(renderer.root, 'Generate').props.onPress();
          await Promise.resolve();
        });

        expect(queryByText(renderer.root, 'Generating image… 0s')).toBeTruthy();

        await act(async () => {
          jest.advanceTimersByTime(3000);
        });
        expect(queryByText(renderer.root, 'Generating image… 3s')).toBeTruthy();
        // Never the multi-image "N of total" copy for a single image.
        expect(queryByText(renderer.root, 'Generating image 1 of 1')).toBeNull();

        await act(async () => {
          renderer.unmount();
        });
      } finally {
        jest.useRealTimers();
      }
    });
  });

  /**
   * Regression tests for the "single-image progress bar freezes while the
   * timer keeps running" bug — the single-image UI must be a smoothly
   * looping indeterminate animation (Animated.loop), restarted on every
   * generation and stopped/reset on success, cancel, error, OR the dialog
   * being closed mid-generation; the real determinate bar is reserved for
   * multi-image batches. `Animated.loop` is stubbed to record start/stop
   * so the animation's lifecycle is directly observable under the test
   * renderer (where nothing actually animates).
   */
  describe('indeterminate progress animation lifecycle', () => {
    let loopSpy: jest.SpyInstance;
    let animationStart: jest.Mock;
    let animationStop: jest.Mock;

    beforeEach(() => {
      animationStart = jest.fn();
      animationStop = jest.fn();
      loopSpy = jest.spyOn(Animated, 'loop').mockImplementation(
        () =>
          ({
            start: animationStart,
            stop: animationStop,
            reset: jest.fn(),
          }) as never
      );
    });

    afterEach(() => {
      loopSpy.mockRestore();
    });

    it('starts a continuously looping indeterminate animation for a single-image generation', async () => {
      const onGenerate = jest.fn(() => new Promise<void>(() => {}));
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          <ImageGenerationModal visible onClose={() => {}} onGenerate={onGenerate} />
        );
      });

      await act(async () => {
        findByLabel(renderer.root, 'Image prompt').props.onChangeText('a cat');
      });
      await act(async () => {
        findByLabel(renderer.root, 'Generate').props.onPress();
        await Promise.resolve();
      });

      expect(loopSpy).toHaveBeenCalledTimes(1);
      expect(animationStart).toHaveBeenCalledTimes(1);
      expect(queryByText(renderer.root, 'Generating image… 0s')).toBeTruthy();

      // Unmounting (busy never ends in this test) stops the loop — the
      // animation never outlives its progress section.
      await act(async () => {
        renderer.unmount();
      });
      expect(animationStop).toHaveBeenCalledTimes(1);
    });

    it('restarts the animation on every generation — stopped on success, started again on the next', async () => {
      let resolveGeneration!: () => void;
      const onGenerate = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveGeneration = resolve;
          })
      );
      const onClose = jest.fn(); // deliberately a no-op, so a second generation can start in the same dialog
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          <ImageGenerationModal visible onClose={onClose} onGenerate={onGenerate} />
        );
      });

      await act(async () => {
        findByLabel(renderer.root, 'Image prompt').props.onChangeText('a cat');
      });
      await act(async () => {
        findByLabel(renderer.root, 'Generate').props.onPress();
        await Promise.resolve();
      });
      expect(animationStart).toHaveBeenCalledTimes(1);

      // First generation succeeds — the animation is stopped and the whole
      // progress section (bar + elapsed counter) is gone.
      await act(async () => {
        resolveGeneration();
        await Promise.resolve();
      });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(animationStop).toHaveBeenCalledTimes(1);
      expect(queryByText(renderer.root, 'Generating image… 0s')).toBeNull();

      // Second generation — the animation starts again from scratch.
      await act(async () => {
        findByLabel(renderer.root, 'Generate').props.onPress();
        await Promise.resolve();
      });
      expect(animationStart).toHaveBeenCalledTimes(2);
      expect(queryByText(renderer.root, 'Generating image… 0s')).toBeTruthy();

      await act(async () => {
        resolveGeneration();
        await Promise.resolve();
      });
    });

    it('stops and resets the animation when generation fails', async () => {
      let rejectGeneration!: (error: Error) => void;
      const onGenerate = jest.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectGeneration = reject;
          })
      );
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          <ImageGenerationModal visible onClose={() => {}} onGenerate={onGenerate} />
        );
      });

      await act(async () => {
        findByLabel(renderer.root, 'Image prompt').props.onChangeText('a cat');
      });
      await act(async () => {
        findByLabel(renderer.root, 'Generate').props.onPress();
        await Promise.resolve();
      });
      expect(animationStart).toHaveBeenCalledTimes(1);

      await act(async () => {
        rejectGeneration(new Error('Generation failed'));
        await Promise.resolve();
      });

      expect(animationStop).toHaveBeenCalledTimes(1);
      expect(queryByText(renderer.root, 'Generating image… 0s')).toBeNull();
      expect(queryByText(renderer.root, 'Generation failed')).toBeTruthy();
    });

    it('stops and resets the animation when the user cancels', async () => {
      const onGenerate = jest.fn((_params, context: { signal: AbortSignal }) => {
        return new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener('abort', () =>
            reject(new RequestCancelledError('cancelled'))
          );
        });
      });
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          <ImageGenerationModal visible onClose={() => {}} onGenerate={onGenerate} />
        );
      });

      await act(async () => {
        findByLabel(renderer.root, 'Image prompt').props.onChangeText('a cat');
      });
      await act(async () => {
        findByLabel(renderer.root, 'Generate').props.onPress();
        await Promise.resolve();
      });
      expect(animationStart).toHaveBeenCalledTimes(1);

      await act(async () => {
        findByLabel(renderer.root, 'Cancel image generation').props.onPress();
        await Promise.resolve();
      });

      expect(animationStop).toHaveBeenCalledTimes(1);
      expect(queryByText(renderer.root, 'Generating image… 0s')).toBeNull();
      // Cancellation is silent — no error banner for the user's own action.
      expect(queryByText(renderer.root, 'cancelled')).toBeNull();
    });

    it('aborts the request and stops the animation when the dialog is closed while generating', async () => {
      let capturedSignal!: AbortSignal;
      const onGenerate = jest.fn((_params, context: { signal: AbortSignal }) => {
        capturedSignal = context.signal;
        return new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener('abort', () =>
            reject(new RequestCancelledError('cancelled'))
          );
        });
      });
      const onClose = jest.fn();
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          <ImageGenerationModal visible onClose={onClose} onGenerate={onGenerate} />
        );
      });

      await act(async () => {
        findByLabel(renderer.root, 'Image prompt').props.onChangeText('a cat');
      });
      await act(async () => {
        findByLabel(renderer.root, 'Generate').props.onPress();
        await Promise.resolve();
      });
      expect(animationStart).toHaveBeenCalledTimes(1);
      expect(capturedSignal.aborted).toBe(false);

      // The parent closes the dialog mid-generation (on Android this is the
      // hardware-back button → Modal.onRequestClose → onClose).
      await act(async () => {
        renderer.update(
          <ImageGenerationModal visible={false} onClose={onClose} onGenerate={onGenerate} />
        );
        await Promise.resolve();
      });

      // Closing behaves exactly like Cancel: the in-flight request is
      // aborted, the animation is stopped, and the progress UI is reset —
      // nothing keeps running invisibly behind the closed dialog.
      expect(capturedSignal.aborted).toBe(true);
      expect(animationStop).toHaveBeenCalledTimes(1);
      expect(queryByText(renderer.root, 'Generating image… 0s')).toBeNull();
      expect(queryByText(renderer.root, 'cancelled')).toBeNull();
    });

    it('drives the loop on the JS driver — react-native-web only loops non-native-driver animations (regression: bar slid once, then froze at the end)', async () => {
      // RNW's Animated.loop routes useNativeDriver:true to _startNativeLoop,
      // which runs the animation exactly once and never restarts it — the
      // recursive JS loop only runs with useNativeDriver:false. Asserting the
      // config guards the fix at its root; the start/stop lifecycle tests
      // around this one cover the reset behavior.
      const timingSpy = jest.spyOn(Animated, 'timing');
      try {
        const onGenerate = jest.fn(() => new Promise<void>(() => {}));
        let renderer!: ReturnType<typeof create>;
        await act(async () => {
          renderer = create(
            <ImageGenerationModal visible onClose={() => {}} onGenerate={onGenerate} />
          );
        });

        await act(async () => {
          findByLabel(renderer.root, 'Image prompt').props.onChangeText('a cat');
        });
        await act(async () => {
          findByLabel(renderer.root, 'Generate').props.onPress();
          await Promise.resolve();
        });

        expect(loopSpy).toHaveBeenCalledTimes(1);
        const progressTimings = timingSpy.mock.calls.filter(
          (call) => (call[1] as { duration?: number } | undefined)?.duration === 1100
        );
        expect(progressTimings.length).toBe(1);
        expect(progressTimings[0]![1]).toMatchObject({
          toValue: 1,
          useNativeDriver: false,
          isInteraction: false, // a looping animation must never hold an InteractionManager handle
        });

        await act(async () => {
          renderer.unmount();
        });
      } finally {
        timingSpy.mockRestore();
      }
    });

    it('never runs the indeterminate loop for a multi-image batch — the real determinate bar is kept', async () => {
      let capturedOnProgress!: (completed: number, total: number) => void;
      const onGenerate = jest.fn(
        (_params, context: { onProgress: (completed: number, total: number) => void }) => {
          capturedOnProgress = context.onProgress;
          return new Promise<void>(() => {}); // never resolves within this test
        }
      );
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          <ImageGenerationModal visible onClose={() => {}} onGenerate={onGenerate} />
        );
      });

      await act(async () => {
        findByLabel(renderer.root, 'Image prompt').props.onChangeText('a cat');
        findByLabel(renderer.root, 'More images').props.onPress(); // 2
        findByLabel(renderer.root, 'More images').props.onPress(); // 3
      });
      await act(async () => {
        findByLabel(renderer.root, 'Generate').props.onPress();
        await Promise.resolve();
      });

      expect(loopSpy).not.toHaveBeenCalled();
      expect(queryByText(renderer.root, 'Generating image 1 of 3')).toBeTruthy();

      await act(async () => {
        capturedOnProgress(2, 3);
      });
      expect(queryByText(renderer.root, 'Generating image 3 of 3')).toBeTruthy();
      expect(loopSpy).not.toHaveBeenCalled();

      await act(async () => {
        renderer.unmount();
      });
    });
  });

  describe('cancellation', () => {
    it('the Cancel button aborts the in-flight generation while busy', async () => {
      let capturedSignal!: AbortSignal;
      const onGenerate = jest.fn((_params, context: { signal: AbortSignal }) => {
        capturedSignal = context.signal;
        return new Promise<void>(() => {});
      });
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          <ImageGenerationModal visible onClose={() => {}} onGenerate={onGenerate} />
        );
      });

      await act(async () => {
        findByLabel(renderer.root, 'Image prompt').props.onChangeText('a cat');
      });
      await act(async () => {
        findByLabel(renderer.root, 'Generate').props.onPress();
        await Promise.resolve();
      });

      expect(capturedSignal.aborted).toBe(false);
      const cancelButton = findByLabel(renderer.root, 'Cancel image generation');
      await act(async () => {
        cancelButton.props.onPress();
      });
      expect(capturedSignal.aborted).toBe(true);

      // onGenerate's Promise never resolves (aborting the signal doesn't
      // itself reject it in this test double) — unmount to stop the
      // elapsed-time useEffect's setInterval from outliving the test.
      await act(async () => {
        renderer.unmount();
      });
    });

    it('a RequestCancelledError from onGenerate is handled silently — no error banner, dialog stays open and idle', async () => {
      const onGenerate = jest.fn().mockRejectedValue(new RequestCancelledError('cancelled'));
      const onClose = jest.fn();
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          <ImageGenerationModal visible onClose={onClose} onGenerate={onGenerate} />
        );
      });

      await act(async () => {
        findByLabel(renderer.root, 'Image prompt').props.onChangeText('a cat');
      });
      await act(async () => {
        findByLabel(renderer.root, 'Generate').props.onPress();
        await Promise.resolve();
      });

      expect(onClose).not.toHaveBeenCalled();
      expect(
        renderer.root.findAll((n) => String(n.type) === 'Text' && n.children.includes('cancelled'))
      ).toHaveLength(0);
      // Idle again — Generate is re-enabled, not stuck showing a spinner.
      expect(findByLabel(renderer.root, 'Generate').props.disabled).toBe(false);
    });
  });

  describe('no duplicate generation from repeated clicks', () => {
    it('a rapid second Generate press while already generating is ignored', async () => {
      const onGenerate = jest.fn(() => new Promise<void>(() => {}));
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          <ImageGenerationModal visible onClose={() => {}} onGenerate={onGenerate} />
        );
      });

      await act(async () => {
        findByLabel(renderer.root, 'Image prompt').props.onChangeText('a cat');
      });
      await act(async () => {
        // Two presses in the same synchronous batch — simulates a fast
        // double-click landing before React has re-rendered with the
        // Generate button's disabled=true.
        const generateButton = findByLabel(renderer.root, 'Generate');
        generateButton.props.onPress();
        generateButton.props.onPress();
        await Promise.resolve();
      });

      expect(onGenerate).toHaveBeenCalledTimes(1);

      await act(async () => {
        renderer.unmount();
      });
    });

    it('Generate is disabled while busy, and Cancel replaces it as the only active action', async () => {
      const onGenerate = jest.fn(() => new Promise<void>(() => {}));
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          <ImageGenerationModal visible onClose={() => {}} onGenerate={onGenerate} />
        );
      });

      await act(async () => {
        findByLabel(renderer.root, 'Image prompt').props.onChangeText('a cat');
      });
      await act(async () => {
        findByLabel(renderer.root, 'Generate').props.onPress();
        await Promise.resolve();
      });

      expect(findByLabel(renderer.root, 'Generate').props.disabled).toBe(true);
      expect(renderer.root.findAll((n) => n.props.accessibilityLabel === 'Cancel')).toHaveLength(0);
      expect(findByLabel(renderer.root, 'Cancel image generation')).toBeTruthy();

      await act(async () => {
        renderer.unmount();
      });
    });
  });

  describe('reference images', () => {
    beforeEach(() => {
      mockRequestPermissions.mockReset();
      mockLaunchImageLibraryAsync.mockReset();
      mockReadPicker.mockReset();
      mockResolveRemote.mockReset();
      mockClient.fetchAttachmentBlob.mockReset();
      mockRequestPermissions.mockResolvedValue({ granted: true });
      mockReadPicker.mockResolvedValue('data:image/png;base64,ENCODED');
      mockResolveRemote.mockResolvedValue({
        previewUri: 'blob:remote',
        dataUrl: 'data:image/png;base64,REMOTE',
      });
    });

    async function open(
      onGenerate: jest.Mock = jest.fn().mockResolvedValue(undefined),
      initialValues?: Record<string, unknown>
    ): Promise<ReturnType<typeof create>> {
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          <ImageGenerationModal
            visible
            onClose={jest.fn()}
            onGenerate={onGenerate}
            initialValues={initialValues as never}
          />
        );
        await Promise.resolve();
      });
      return renderer;
    }

    async function pressAdd(renderer: ReturnType<typeof create>): Promise<void> {
      await act(async () => {
        findByLabel(renderer.root, 'Add reference image').props.onPress();
        // flush permission → picker → staged-state microtasks
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
    }

    it('picking an image renders a removable chip', async () => {
      mockLaunchImageLibraryAsync.mockResolvedValue({
        canceled: false,
        assets: [
          {
            uri: 'blob:1',
            fileName: 'finch.png',
            mimeType: 'image/png',
            fileSize: 1024,
            file: null,
          },
        ],
      });
      const renderer = await open();

      await pressAdd(renderer);

      expect(queryByText(renderer.root, 'finch.png')).toBeTruthy();
      expect(findByLabel(renderer.root, 'Remove finch.png')).toBeTruthy();

      await act(async () => {
        findByLabel(renderer.root, 'Remove finch.png').props.onPress();
      });
      expect(queryByText(renderer.root, 'finch.png')).toBeNull();
    });

    it('caps additions at MAX_REFERENCE_IMAGES (the Add button disappears at the cap)', async () => {
      // Four references already present → no Add button.
      const referenceImages = Array.from({ length: 4 }, (_, i) => ({
        name: `r${i}.png`,
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,X',
      }));
      const renderer = await open(jest.fn(), { referenceImages });
      expect(
        renderer.root.findAll((n) => n.props.accessibilityLabel === 'Add reference image')
      ).toHaveLength(0);
    });

    it('denied photo-library permission shows an error and adds nothing', async () => {
      mockRequestPermissions.mockResolvedValue({ granted: false });
      const renderer = await open();

      await pressAdd(renderer);

      expect(mockLaunchImageLibraryAsync).not.toHaveBeenCalled();
      expect(
        queryByText(renderer.root, 'Photo library access is required to add reference images.')
      ).toBeTruthy();
    });

    it('an unsupported reference type shows an inline error and blocks Generate', async () => {
      mockLaunchImageLibraryAsync.mockResolvedValue({
        canceled: false,
        assets: [
          {
            uri: 'blob:1',
            fileName: 'anim.gif',
            mimeType: 'image/gif',
            fileSize: 1024,
            file: null,
          },
        ],
      });
      const renderer = await open();

      await pressAdd(renderer);

      expect(
        textMatching(renderer.root, /isn't a supported reference image type/).length
      ).toBeGreaterThan(0);
      expect(findByLabel(renderer.root, 'Generate').props.disabled).toBe(true);
    });

    it('Generate stays disabled while a reference is still encoding', async () => {
      mockLaunchImageLibraryAsync.mockResolvedValue({
        canceled: false,
        assets: [
          {
            uri: 'blob:1',
            fileName: 'slow.png',
            mimeType: 'image/png',
            fileSize: 1024,
            file: null,
          },
        ],
      });
      mockReadPicker.mockReturnValue(new Promise(() => {})); // never resolves
      const renderer = await open();

      await act(async () => {
        findByLabel(renderer.root, 'Image prompt').props.onChangeText('a prompt');
      });
      await pressAdd(renderer);

      expect(findByLabel(renderer.root, 'Generate').props.disabled).toBe(true);
    });

    it('onGenerate carries the encoded reference data URLs', async () => {
      mockLaunchImageLibraryAsync.mockResolvedValue({
        canceled: false,
        assets: [
          {
            uri: 'blob:1',
            fileName: 'finch.png',
            mimeType: 'image/png',
            fileSize: 1024,
            file: null,
          },
        ],
      });
      const onGenerate = jest.fn().mockResolvedValue(undefined);
      const renderer = await open(onGenerate);

      await pressAdd(renderer);
      await act(async () => {
        // let readPickerAssetAsDataUrl's .then apply the dataUrl + clear loading
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      await act(async () => {
        findByLabel(renderer.root, 'Image prompt').props.onChangeText('the Finch robot on Mars');
      });
      await act(async () => {
        findByLabel(renderer.root, 'Generate').props.onPress();
        await Promise.resolve();
      });

      expect(onGenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          referenceImages: [{ dataUrl: 'data:image/png;base64,ENCODED', mimeType: 'image/png' }],
        }),
        expect.anything()
      );
    });

    it('a Regenerate remote reference is prefilled, refetched, and resent', async () => {
      const onGenerate = jest.fn().mockResolvedValue(undefined);
      const renderer = await open(onGenerate, {
        prompt: 'same scene, new seed',
        referenceImages: [
          {
            name: 'saved-ref.png',
            mimeType: 'image/png',
            remote: { conversationId: 'c1', messageId: 'm1', attachmentId: 'a1' },
          },
        ],
      });

      // The resolve-on-open effect refetches the remote reference.
      await act(async () => {
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(mockResolveRemote).toHaveBeenCalledWith(
        mockClient,
        { conversationId: 'c1', messageId: 'm1', attachmentId: 'a1' },
        'image/png',
        'saved-ref.png'
      );
      expect(queryByText(renderer.root, 'saved-ref.png')).toBeTruthy();

      await act(async () => {
        findByLabel(renderer.root, 'Generate').props.onPress();
        await Promise.resolve();
      });
      expect(onGenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'same scene, new seed',
          referenceImages: [{ dataUrl: 'data:image/png;base64,REMOTE', mimeType: 'image/png' }],
        }),
        expect.anything()
      );
    });
  });
});
