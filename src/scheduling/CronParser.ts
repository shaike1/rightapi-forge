// Cron expression parser and validator
// Supports standard cron format: minute hour day month weekday

export interface CronFields {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

export class CronParser {
  static parse(expression: string): CronFields {
    const parts = expression.trim().split(/\s+/);
    
    if (parts.length !== 5) {
      throw new Error('Invalid cron expression: must have 5 fields (minute hour day month weekday)');
    }
    
    return {
      minute: this.parseField(parts[0], 0, 59),
      hour: this.parseField(parts[1], 0, 23),
      dayOfMonth: this.parseField(parts[2], 1, 31),
      month: this.parseField(parts[3], 1, 12),
      dayOfWeek: this.parseField(parts[4], 0, 6)
    };
  }
  
  static validate(expression: string): { valid: boolean; error?: string } {
    try {
      this.parse(expression);
      return { valid: true };
    } catch (error) {
      return { valid: false, error: (error as Error).message };
    }
  }
  
  static getNextRun(expression: string, from: Date = new Date(), timezone?: string): Date {
    const fields = this.parse(expression);
    let current = new Date(from);
    current.setSeconds(0);
    current.setMilliseconds(0);
    
    // Advance to next minute
    current.setMinutes(current.getMinutes() + 1);
    
    // Find next matching time (max 4 years in future)
    const maxIterations = 60 * 24 * 365 * 4; // 4 years worth of minutes
    let iterations = 0;
    
    while (iterations < maxIterations) {
      if (
        fields.minute.includes(current.getMinutes()) &&
        fields.hour.includes(current.getHours()) &&
        fields.dayOfMonth.includes(current.getDate()) &&
        fields.month.includes(current.getMonth() + 1) &&
        fields.dayOfWeek.includes(current.getDay())
      ) {
        return current;
      }
      
      current.setMinutes(current.getMinutes() + 1);
      iterations++;
    }
    
    throw new Error('Could not find next run time within 4 years');
  }
  
  static describe(expression: string): string {
    try {
      const fields = this.parse(expression);
      const parts: string[] = [];
      
      // Minute
      if (fields.minute.length === 60) {
        parts.push('every minute');
      } else if (fields.minute.length === 1) {
        parts.push(`at minute ${fields.minute[0]}`);
      } else {
        parts.push(`at minutes ${fields.minute.slice(0, 3).join(', ')}${fields.minute.length > 3 ? '...' : ''}`);
      }
      
      // Hour
      if (fields.hour.length === 24) {
        parts.push('every hour');
      } else if (fields.hour.length === 1) {
        parts.push(`at ${fields.hour[0]}:00`);
      }
      
      // Day of month
      if (fields.dayOfMonth.length < 31) {
        if (fields.dayOfMonth.length === 1) {
          parts.push(`on day ${fields.dayOfMonth[0]}`);
        } else {
          parts.push(`on days ${fields.dayOfMonth.slice(0, 3).join(', ')}${fields.dayOfMonth.length > 3 ? '...' : ''}`);
        }
      }
      
      // Month
      if (fields.month.length < 12) {
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const months = fields.month.map(m => monthNames[m - 1]);
        parts.push(`in ${months.join(', ')}`);
      }
      
      // Day of week
      if (fields.dayOfWeek.length < 7) {
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const days = fields.dayOfWeek.map(d => dayNames[d]);
        parts.push(`on ${days.join(', ')}`);
      }
      
      return parts.join(', ');
    } catch (error) {
      return 'Invalid cron expression';
    }
  }
  
  private static parseField(field: string, min: number, max: number): number[] {
    const values = new Set<number>();
    
    // Split by comma
    const parts = field.split(',');
    
    for (const part of parts) {
      if (part === '*') {
        // All values
        for (let i = min; i <= max; i++) {
          values.add(i);
        }
      } else if (part.includes('/')) {
        // Step values (e.g., */5 or 0-30/5)
        const [range, step] = part.split('/');
        const stepNum = parseInt(step, 10);
        
        if (isNaN(stepNum) || stepNum < 1) {
          throw new Error(`Invalid step value: ${step}`);
        }
        
        let start = min;
        let end = max;
        
        if (range !== '*') {
          if (range.includes('-')) {
            const [rangeStart, rangeEnd] = range.split('-');
            start = parseInt(rangeStart, 10);
            end = parseInt(rangeEnd, 10);
          } else {
            start = parseInt(range, 10);
            end = max;
          }
        }
        
        for (let i = start; i <= end; i += stepNum) {
          if (i >= min && i <= max) {
            values.add(i);
          }
        }
      } else if (part.includes('-')) {
        // Range (e.g., 1-5)
        const [start, end] = part.split('-');
        const startNum = parseInt(start, 10);
        const endNum = parseInt(end, 10);
        
        if (isNaN(startNum) || isNaN(endNum)) {
          throw new Error(`Invalid range: ${part}`);
        }
        
        for (let i = startNum; i <= endNum; i++) {
          if (i >= min && i <= max) {
            values.add(i);
          }
        }
      } else {
        // Single value
        const num = parseInt(part, 10);
        if (isNaN(num) || num < min || num > max) {
          throw new Error(`Invalid value: ${part} (must be ${min}-${max})`);
        }
        values.add(num);
      }
    }
    
    return Array.from(values).sort((a, b) => a - b);
  }
}
