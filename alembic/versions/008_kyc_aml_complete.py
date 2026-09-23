"""KYC/AML complete schema aligned with Supabase SQL.

Revision ID: 008kyc_aml
Revises: 007_add_banner_url_users
Create Date: 2026-09-14
"""
from pathlib import Path
from typing import Sequence, Union

from alembic import op

revision: str = "008kyc_aml"
down_revision: Union[str, None] = "007_add_banner_url_users"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _sql_path() -> Path:
    return Path(__file__).resolve().parents[2] / "migrations" / "008_kyc_aml_complete.sql"


def upgrade() -> None:
    sql = _sql_path().read_text(encoding="utf-8")
    op.get_bind().exec_driver_sql(sql)


def downgrade() -> None:
    conn = op.get_bind()
    conn.exec_driver_sql("DROP VIEW IF EXISTS pending_sars_view CASCADE")
    conn.exec_driver_sql("DROP VIEW IF EXISTS kyc_dashboard_view CASCADE")
    for trigger, table in [
        ("trg_tx_flag_audit", "transactions"),
        ("trg_sync_kyc_status", "kyc_verifications"),
        ("trg_sar_updated_at", "suspicious_activity_reports"),
        ("trg_kyc_audit_no_delete", "kyc_audit_log"),
        ("trg_kyc_audit_no_update", "kyc_audit_log"),
        ("trg_kyc_documents_updated_at", "kyc_documents"),
        ("trg_kyc_personal_updated_at", "kyc_personal_data"),
        ("trg_kyc_attempts_updated_at", "kyc_attempts"),
        ("trg_kyc_updated_at", "kyc_verifications"),
        ("trg_admin_users_updated_at", "admin_users"),
    ]:
        conn.exec_driver_sql(f"DROP TRIGGER IF EXISTS {trigger} ON {table}")
    for function in [
        "fn_egchat_tx_flag_audit",
        "fn_egchat_sync_user_kyc_status",
        "fn_egchat_audit_log_immutable",
        "fn_egchat_set_updated_at",
    ]:
        conn.exec_driver_sql(f"DROP FUNCTION IF EXISTS {function}() CASCADE")
    for table in [
        "suspicious_activity_reports",
        "kyc_audit_log",
        "kyc_screening_results",
        "kyc_documents",
        "kyc_personal_data",
        "kyc_attempts",
        "admin_users",
    ]:
        conn.exec_driver_sql(f"DROP TABLE IF EXISTS {table} CASCADE")
