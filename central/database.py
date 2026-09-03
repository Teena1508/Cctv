import os
import time
from sqlalchemy import create_engine, Column, Integer, String, Float, DateTime, text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://cctv_admin:cctv_password@localhost:5432/cctv_db")

engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

class Alert(Base):
    __tablename__ = "alerts"

    id = Column(Integer, primary_key=True, index=True)
    node_id = Column(String(50), nullable=False)
    event_type = Column(String(100), nullable=False)
    severity = Column(String(20), nullable=False)
    details = Column(String(255), nullable=True)
    status = Column(String(50), default="PENDING", nullable=False)
    lat = Column(Float, nullable=False)
    lng = Column(Float, nullable=False)
    extra_info = Column(String(255), nullable=True)
    timestamp = Column(DateTime, server_default=text("NOW()"))

def init_db():
    print("[Central DB] Initializing PostgreSQL database with PostGIS...")
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1;"))
    except Exception as e:
        print(f"[Central DB] PostgreSQL server not running locally ({e}). Operating with in-memory fallback.")
        return False
    for i in range(3):
        try:
            with engine.connect() as conn:
                # Enable PostGIS extension
                conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis;"))
                conn.commit()
                print("[Central DB] PostGIS extension initialized.")
            
            # Create SQLAlchemy tables
            Base.metadata.create_all(bind=engine)
            
            # Add spatial column, index, and trigger to automatically populate geom Point from lat/lng
            with engine.connect() as conn:
                conn.execute(text("""
                    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS geom GEOMETRY(Point, 4326);
                """))
                conn.execute(text("""
                    CREATE INDEX IF NOT EXISTS alerts_geom_idx ON alerts USING GIST (geom);
                """))
                
                # Trigger setup for automatic geom point creation
                conn.execute(text("""
                    CREATE OR REPLACE FUNCTION update_alert_geom()
                    RETURNS TRIGGER AS $$
                    BEGIN
                        NEW.geom := ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326);
                        RETURN NEW;
                    END;
                    $$ LANGUAGE plpgsql;
                """))
                
                # Check and create trigger
                conn.execute(text("""
                    DROP TRIGGER IF EXISTS trg_update_alert_geom ON alerts;
                    CREATE TRIGGER trg_update_alert_geom
                    BEFORE INSERT ON alerts
                    FOR EACH ROW
                    EXECUTE FUNCTION update_alert_geom();
                """))
                conn.commit()
                
            print("[Central DB] Database tables, spatial columns, and triggers configured successfully.")
            return True
        except Exception as e:
            print(f"[Central DB] Connection retry {i+1}/10 failed. Database might still be starting. Error: {e}")
            time.sleep(3)
    return False

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
