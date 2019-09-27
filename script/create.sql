CREATE DATABASE qa_review_db;

CREATE TABLE IF NOT EXISTS github_review (
    id serial NOT NULL PRIMARY KEY,
    event VARCHAR (20) NOT NULL,
    action VARCHAR (20) NOT NULL,
    repo VARCHAR (50) NOT NULL,
    sender VARCHAR (100) NOT NULL,
    title VARCHAR (200) NOT NULL,
    html_url VARCHAR (100) NOT NULL,
    is_requested BOOLEAN NOT NULL,
    is_done BOOLEAN NOT NULL,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
);
