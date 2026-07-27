import { StyleSheet, Switch, Text, View } from 'react-native';

export interface CorpusToggleProps {
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
}

/**
 * The "Also use my research corpus" toggle (milestone V3) — only ever
 * rendered by the composer while at least one attachment is pending
 * (see chat/new.tsx / chat/[id].tsx): a text-only message has no such
 * choice to make, since retrieval has always run unconditionally for it.
 * Off (vision-only, the default) means the answer only ever reasons about
 * the attached image(s)/page(s), with no [S#] citations possible at all;
 * on (vision + corpus) also runs retrieval alongside vision and can
 * produce real [S1]/[S2]-style citations for corpus-drawn claims — see
 * rag-backend's app/core/model_routing.py.
 */
export function CorpusToggle({ value, onValueChange, disabled = false }: CorpusToggleProps) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>Also use my research corpus</Text>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        accessibilityLabel="Also use my research corpus"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 6,
  },
  label: { fontSize: 12, color: '#334155', fontWeight: '500' },
});
