import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const req = ctx.getRequest();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: any = 'Internal server error';
    let details: any;
    let exCode: string | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r: any = exception.getResponse();
      message = typeof r === 'string' ? r : r.message ?? exception.message;
      if (r && typeof r === 'object') {
        if (r.details !== undefined) details = r.details;
        if (r.code) exCode = r.code;
      }
      if (Array.isArray(message)) {
        details = message;
        message = 'Validation failed';
      }
    } else if (exception?.code === '23505') {
      status = HttpStatus.CONFLICT;
      message = 'Duplicate value: ' + (exception.detail ?? 'unique constraint violated');
    } else if (exception?.code === '23503') {
      status = HttpStatus.CONFLICT;
      message = 'Cannot complete: record is referenced by, or references, other data';
    } else if (exception?.code === '22P02') {
      status = HttpStatus.BAD_REQUEST;
      message = 'Invalid identifier or value';
    }

    if (status >= 500) this.logger.error(`${req.method} ${req.url} -> ${exception?.stack ?? exception}`);

    res.status(status).json({
      statusCode: status,
      message,
      ...(exCode ? { code: exCode } : {}),
      details,
      path: req.url,
      timestamp: new Date().toISOString(),
    });
  }
}
