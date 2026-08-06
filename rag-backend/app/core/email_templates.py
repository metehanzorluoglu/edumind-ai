"""Content for every transactional email this app sends — currently just
account-verification. Kept separate from app/core/email_provider.py
(which only knows how to *deliver* a subject/html/text triple, not what
one should say) and from app/core/verification_service.py (which decides
*when* to send one).
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class EmailContent:
    subject: str
    html_body: str
    text_body: str


def build_verification_email(*, verification_url: str, ttl_minutes: int) -> EmailContent:
    """Never includes a password or any other account/session detail —
    only the single-use verification link and how long it's valid for."""
    subject = "Verify your EduM8 email address"

    text_body = (
        "Verify your EduM8 email address\n\n"
        "Welcome to EduM8 — your private AI workspace for learning and research.\n\n"
        "Confirm this email address to finish creating your account:\n"
        f"{verification_url}\n\n"
        f"This link expires in {ttl_minutes} minutes.\n\n"
        "If you didn't create an EduM8 account, you can safely ignore this email — "
        "no account will be created without confirming this link.\n"
    )

    body_font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"
    muted = "font-size:12px;color:#94A3B8;line-height:18px;"
    button_style = (
        "display:inline-block;background-color:#4F46E5;color:#FFFFFF;font-weight:600;"
        "font-size:15px;text-decoration:none;padding:12px 28px;border-radius:8px;"
    )
    html_body = f"""\
<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:#F8FAFC;{body_font}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="background-color:#F8FAFC;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%"
                 style="max-width:420px;background-color:#FFFFFF;border-radius:12px;padding:32px;">
            <tr>
              <td align="center" style="padding-bottom:4px;">
                <!-- Text wordmark, not an <img> of the E8 mark: most mail
                     clients block remote images by default (a broken-image
                     icon is worse than no logo at all), and inlining an SVG
                     or base64 PNG here isn't reliably supported across
                     clients either. #0F172A is this template's own
                     near-black ink — matches brand/BRAND_GUIDELINES.md's
                     text color closely enough without pulling in the app's
                     token system, which doesn't exist in this email-only
                     context. -->
                <span style="font-size:26px;font-weight:800;color:#0F172A;letter-spacing:-0.5px;">
                  EduM8
                </span>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding-bottom:24px;">
                <span style="font-size:13px;color:#64748B;">Education Research Assistant</span>
              </td>
            </tr>
            <tr>
              <td style="font-size:15px;color:#334155;line-height:22px;padding-bottom:24px;">
                Confirm this email address to finish creating your EduM8 account.
              </td>
            </tr>
            <tr>
              <td align="center" style="padding-bottom:24px;">
                <a href="{verification_url}" style="{button_style}">Verify email address</a>
              </td>
            </tr>
            <tr>
              <td style="{muted}padding-bottom:16px;word-break:break-all;">
                Or paste this link into your browser:<br />
                <a href="{verification_url}" style="color:#4F46E5;">{verification_url}</a>
              </td>
            </tr>
            <tr>
              <td style="{muted}padding-bottom:8px;">
                This link expires in {ttl_minutes} minutes.
              </td>
            </tr>
            <tr>
              <td style="{muted}border-top:1px solid #E2E8F0;padding-top:16px;">
                If you didn't create an EduM8 account, you can safely ignore this email —
                no account will be created without confirming this link.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
"""

    return EmailContent(subject=subject, html_body=html_body, text_body=text_body)
