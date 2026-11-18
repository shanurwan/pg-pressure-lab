FROM alpine:3.22
RUN apk add --no-cache pgbouncer
COPY pgbouncer.ini userlist.txt /etc/pgbouncer/
USER nobody
EXPOSE 6432
CMD ["pgbouncer", "/etc/pgbouncer/pgbouncer.ini"]
