-- name: GetAuthor :one
SELECT * FROM authors
WHERE id = $1 LIMIT 1;

-- name: ListAuthors :many
SELECT * FROM authors
ORDER BY name;

-- name: CreateAuthor :one
INSERT INTO authors (
  name, bio
) VALUES (
  $1, $2
)
RETURNING *;

-- name: DeleteAuthor :exec
DELETE FROM authors
WHERE id = $1;

-- name: BatchCreateAuthor :batchone
INSERT INTO authors (
  name, bio
) VALUES (
  $1, $2
)
RETURNING *;

-- name: BatchListAuthorsByBio :batchmany
SELECT * FROM authors
WHERE bio = $1
ORDER BY name;

-- name: BatchDeleteAuthor :batchexec
DELETE FROM authors
WHERE id = $1;
