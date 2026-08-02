"""Covers app/core/password_policy.py — the centralized strength policy
shared by POST /auth/register (and any future password-change/reset
route). Every explicit example from the task's own requirements is tested
by name (e.g. "12345678", "Password123!").
"""

from app.core.password_policy import MAX_PASSWORD_LENGTH, validate_password_policy


def _codes(password: str, **kwargs: object) -> set[str]:
    return {error.code for error in validate_password_policy(password, **kwargs)}


class TestAcceptedPasswords:
    def test_a_strong_unique_password_is_accepted(self) -> None:
        assert validate_password_policy("Xq7!vTr9zLmP#4") == []

    def test_password_manager_generated_password_is_accepted(self) -> None:
        assert validate_password_policy("k9#Wp2$Yz8@Lm4Q") == []

    def test_max_length_boundary_is_accepted(self) -> None:
        password = "Aa1!" + "x" * (MAX_PASSWORD_LENGTH - 4)
        assert len(password) == MAX_PASSWORD_LENGTH
        assert validate_password_policy(password) == []


class TestRejectedExplicitExamples:
    """Every password literally named in the task's requirements."""

    def test_12345678(self) -> None:
        assert _codes("12345678") & {"min_length", "common_password"}

    def test_123456789(self) -> None:
        assert _codes("123456789") & {"min_length", "common_password"}

    def test_password(self) -> None:
        assert _codes("password") & {"min_length", "common_password"}

    def test_password123(self) -> None:
        assert _codes("password123") & {"min_length", "common_password"}

    def test_password123_bang(self) -> None:
        # Exactly 12 chars and satisfies every composition rule — only the
        # denylist catches this, proving the denylist matters and isn't
        # redundant with length/composition alone.
        codes = _codes("Password123!")
        assert "common_password" in codes
        assert "min_length" not in codes

    def test_qwerty123(self) -> None:
        assert _codes("qwerty123") & {"min_length", "common_password"}

    def test_abcdefgh(self) -> None:
        codes = _codes("abcdefgh")
        assert "min_length" in codes
        assert "repeated_or_sequential" in codes

    def test_letmein(self) -> None:
        assert _codes("letmein") & {"min_length", "common_password"}

    def test_admin123(self) -> None:
        assert _codes("admin123") & {"min_length", "common_password"}

    def test_welcome123(self) -> None:
        assert _codes("welcome123") & {"min_length", "common_password"}


class TestCompositionRules:
    def test_missing_uppercase_is_rejected(self) -> None:
        assert "uppercase" in _codes("lowercase123!only")

    def test_missing_lowercase_is_rejected(self) -> None:
        assert "lowercase" in _codes("UPPERCASE123!ONLY")

    def test_missing_digit_is_rejected(self) -> None:
        assert "digit" in _codes("NoDigitsHere!Only")

    def test_missing_symbol_is_rejected(self) -> None:
        assert "symbol" in _codes("NoSymbolsHere1234")

    def test_too_short_is_rejected(self) -> None:
        assert "min_length" in _codes("Aa1!")

    def test_too_long_is_rejected(self) -> None:
        password = "Aa1!" + "x" * (MAX_PASSWORD_LENGTH - 3)
        assert len(password) == MAX_PASSWORD_LENGTH + 1
        assert "max_length" in _codes(password)

    def test_empty_password_is_rejected_with_only_the_empty_code(self) -> None:
        assert _codes("") == {"empty"}

    def test_whitespace_only_password_is_rejected(self) -> None:
        assert "empty" in _codes("    ")


class TestSequentialAndRepeatedRejection:
    def test_all_same_character_is_rejected(self) -> None:
        assert "repeated_or_sequential" in _codes("aaaaaaaaaaaa")

    def test_ascending_sequence_is_rejected(self) -> None:
        assert "repeated_or_sequential" in _codes("abcdefghijkl")

    def test_descending_sequence_is_rejected(self) -> None:
        assert "repeated_or_sequential" in _codes("lkjihgfedcba")

    def test_non_sequential_strong_password_is_not_flagged(self) -> None:
        assert "repeated_or_sequential" not in _codes("Xq7!vTr9zLmP#4")


class TestContainsIdentity:
    def test_full_normalized_email_in_password_is_rejected(self) -> None:
        codes = _codes(
            "Str0ng!user@example.com", normalized_email="user@example.com"
        )
        assert "contains_identity" in codes

    def test_email_local_part_in_password_is_rejected_when_long_enough(self) -> None:
        codes = _codes("MyPasswordIsJdoe123!", normalized_email="jdoe@example.com")
        assert "contains_identity" in codes

    def test_short_email_local_part_is_not_flagged_to_avoid_false_positives(self) -> None:
        # "jo" (2 chars) is below the substring threshold — a coincidental
        # match inside an otherwise-strong password shouldn't reject it.
        codes = _codes("Xq7!vTr9zLmP#4", normalized_email="jo@example.com")
        assert "contains_identity" not in codes

    def test_display_name_in_password_is_rejected(self) -> None:
        codes = _codes("MySecretJennifer1!", display_name="Jennifer Smith")
        assert "contains_identity" in codes

    def test_unrelated_name_and_email_do_not_trigger_false_positive(self) -> None:
        codes = _codes(
            "Xq7!vTr9zLmP#4", normalized_email="user@example.com", display_name="Ada Lovelace"
        )
        assert "contains_identity" not in codes


class TestReturnsEveryViolation:
    def test_multiple_rule_violations_are_all_reported_at_once(self) -> None:
        # Short, no uppercase, no digit, no symbol, and common — every one
        # of these should be reported, not just the first.
        codes = _codes("weak")
        assert {"min_length", "uppercase", "digit", "symbol"} <= codes
